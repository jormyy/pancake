DELETE FROM public.trade_drop_reservations AS reservation
WHERE NOT EXISTS (
  SELECT 1
    FROM public.trades AS trade
   WHERE trade.id = reservation.trade_id
     AND trade.status = 'accepted'::trade_status
);

DELETE FROM public.trade_drop_reservations AS later
USING public.trade_drop_reservations AS earlier
WHERE later.roster_player_id = earlier.roster_player_id
  AND later.id <> earlier.id
  AND (
    later.created_at > earlier.created_at
    OR (later.created_at = earlier.created_at AND later.id > earlier.id)
  );

ALTER TABLE public.trade_drop_reservations
  DROP CONSTRAINT IF EXISTS trade_drop_reservations_roster_player_id_fkey;

ALTER TABLE public.trade_drop_reservations
  ADD CONSTRAINT trade_drop_reservations_roster_player_id_fkey
  FOREIGN KEY (roster_player_id)
  REFERENCES public.roster_players(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_drop_reservations_roster_player_id
  ON public.trade_drop_reservations(roster_player_id);

CREATE OR REPLACE FUNCTION private.cleanup_trade_drop_reservations_on_terminal_trade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF OLD.status = 'accepted'::trade_status
     AND NEW.status <> 'accepted'::trade_status THEN
    DELETE FROM trade_drop_reservations
     WHERE trade_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cleanup_trade_drop_reservations_on_terminal_trade ON public.trades;
CREATE TRIGGER cleanup_trade_drop_reservations_on_terminal_trade
  AFTER UPDATE OF status ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION private.cleanup_trade_drop_reservations_on_terminal_trade();

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid,
  p_drop_roster_player_ids uuid[] DEFAULT ARRAY[]::uuid[]
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
  v_drop_ids uuid[] := COALESCE(p_drop_roster_player_ids, ARRAY[]::uuid[]);
  v_from_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
  v_incoming_players int;
  v_outgoing_players int;
  v_required_drops int;
  v_proposer_active_count int;
  v_proposer_incoming_players int;
  v_proposer_outgoing_players int;
  v_proposer_required_drops int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'pending' THEN
    RAISE EXCEPTION 'This trade is no longer pending';
  END IF;

  IF v_trade.recipient_member_id <> p_accepting_member_id THEN
    RAISE EXCEPTION 'Only the recipient can accept this trade';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    );
  END LOOP;

  IF (SELECT count(*) FROM unnest(v_drop_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_drop_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate drop players are not allowed.';
  END IF;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM (
        SELECT player_id
          FROM trade_items
         WHERE trade_id = p_trade_id
           AND player_id IS NOT NULL
        UNION ALL
        SELECT player_id
          FROM roster_players
         WHERE id = ANY(v_drop_ids)
      ) AS touched
     WHERE player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.'
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

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

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
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_items AS accepted_item
          JOIN trades AS accepted_trade
            ON accepted_trade.id = accepted_item.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE accepted_item.player_id = v_item.player_id
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
           AND (
             (accepted_item.side = 'proposer' AND accepted_trade.proposer_member_id = v_from_member)
             OR (accepted_item.side = 'recipient' AND accepted_trade.recipient_member_id = v_from_member)
           )
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_drop_reservations AS reservation
          JOIN trades AS accepted_trade
            ON accepted_trade.id = reservation.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE reservation.player_id = v_item.player_id
           AND reservation.member_id = v_from_member
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved as a drop for another accepted trade';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_items AS accepted_item
          JOIN trades AS accepted_trade
            ON accepted_trade.id = accepted_item.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE accepted_item.pick_id = v_item.pick_id
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
      ) THEN
        RAISE EXCEPTION 'Draft-pick asset is reserved for another accepted trade';
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_drop_ids) > 0 THEN
    WITH locked AS (
      SELECT *
        FROM roster_players
       WHERE id = ANY(v_drop_ids)
         AND league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = p_accepting_member_id
         AND is_on_ir = false
         AND is_on_taxi = false
       FOR UPDATE
    )
    SELECT count(*) INTO v_rows FROM locked;

    IF v_rows <> cardinality(v_drop_ids) THEN
      RAISE EXCEPTION 'Drop list includes a player that is no longer on your active roster.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM roster_players AS rp
        JOIN trade_items AS ti
          ON ti.trade_id = p_trade_id
         AND ti.player_id = rp.player_id
       WHERE rp.id = ANY(v_drop_ids)
    ) THEN
      RAISE EXCEPTION 'You cannot drop a player included in this trade.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM trade_drop_reservations AS reservation
        JOIN trades AS trade
          ON trade.id = reservation.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE reservation.roster_player_id = ANY(v_drop_ids)
         AND reservation.trade_id <> p_trade_id
    ) THEN
      RAISE EXCEPTION 'A selected drop player is already reserved for another accepted trade.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM roster_players AS rp
        JOIN trade_items AS accepted_item
          ON accepted_item.player_id = rp.player_id
        JOIN trades AS accepted_trade
          ON accepted_trade.id = accepted_item.trade_id
         AND accepted_trade.status = 'accepted'::trade_status
       WHERE rp.id = ANY(v_drop_ids)
         AND accepted_trade.id <> p_trade_id
         AND accepted_trade.league_id = v_trade.league_id
         AND accepted_trade.league_season_id = v_trade.league_season_id
         AND (
           (accepted_item.side = 'proposer' AND accepted_trade.proposer_member_id = rp.member_id)
           OR (accepted_item.side = 'recipient' AND accepted_trade.recipient_member_id = rp.member_id)
         )
    ) THEN
      RAISE EXCEPTION 'A selected drop player is reserved as an asset for another accepted trade.';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE league_id = v_trade.league_id
     AND league_season_id = v_trade.league_season_id
     AND member_id = p_accepting_member_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  SELECT count(*)
    INTO v_incoming_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'proposer'
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'recipient'
     AND player_id IS NOT NULL;

  v_required_drops := GREATEST(v_active_count - v_outgoing_players + v_incoming_players - COALESCE(v_league.roster_size, 0), 0);
  IF cardinality(v_drop_ids) <> v_required_drops THEN
    RAISE EXCEPTION 'Accepting this trade requires exactly % active roster drop(s).', v_required_drops;
  END IF;

  SELECT count(*)
    INTO v_proposer_active_count
    FROM roster_players
   WHERE league_id = v_trade.league_id
     AND league_season_id = v_trade.league_season_id
     AND member_id = v_trade.proposer_member_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  SELECT count(*)
    INTO v_proposer_incoming_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'recipient'
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_proposer_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'proposer'
     AND player_id IS NOT NULL;

  v_proposer_required_drops := GREATEST(
    v_proposer_active_count - v_proposer_outgoing_players + v_proposer_incoming_players - COALESCE(v_league.roster_size, 0),
    0
  );

  IF v_proposer_required_drops > 0 THEN
    RAISE EXCEPTION 'This trade would overfill the proposer roster.';
  END IF;

  DELETE FROM trade_drop_reservations WHERE trade_id = p_trade_id;

  INSERT INTO trade_drop_reservations (
    trade_id,
    roster_player_id,
    member_id,
    player_id
  )
  SELECT
    p_trade_id,
    rp.id,
    rp.member_id,
    rp.player_id
  FROM roster_players AS rp
  WHERE rp.id = ANY(v_drop_ids)
  ORDER BY rp.player_id ASC;

  UPDATE trades
     SET status = 'accepted',
         accepted_at = now(),
         veto_window_expires_at = now() + INTERVAL '24 hours',
         completed_at = NULL,
         vetoed_at = NULL
   WHERE id = p_trade_id
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to accept trade atomically';
  END IF;
END;
$$;

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
  v_drop trade_drop_reservations%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
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
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    );
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM (
        SELECT player_id
          FROM trade_items
         WHERE trade_id = p_trade_id
           AND player_id IS NOT NULL
        UNION ALL
        SELECT player_id
          FROM trade_drop_reservations
         WHERE trade_id = p_trade_id
      ) AS touched
     WHERE player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.'
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

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

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
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;
    END IF;
  END LOOP;

  FOR v_drop IN
    SELECT *
      FROM trade_drop_reservations
     WHERE trade_id = p_trade_id
     ORDER BY player_id ASC
     FOR UPDATE
  LOOP
    DELETE FROM trade_drop_reservations
     WHERE id = v_drop.id;

    DELETE FROM roster_players
     WHERE id = v_drop.roster_player_id
       AND league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_drop.member_id
       AND player_id = v_drop.player_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Reserved drop player is no longer on the expected roster.';
    END IF;

    DELETE FROM weekly_lineups AS wl
     WHERE wl.league_id = v_trade.league_id
       AND wl.league_season_id = v_trade.league_season_id
       AND wl.member_id = v_drop.member_id
       AND wl.player_id = v_drop.player_id
       AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
       AND NOT EXISTS (
         SELECT 1
           FROM players AS p
           JOIN nba_games AS g
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
      v_trade.league_id,
      v_trade.league_season_id,
      v_drop.player_id,
      v_drop.member_id,
      now() + interval '48 hours'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_drop.member_id,
      v_drop.player_id,
      'fa_drop'
    );
  END LOOP;

  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = v_trade.league_id
     AND wl.league_season_id = v_trade.league_season_id
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND wl.player_id IN (
       SELECT ti.player_id
         FROM trade_items AS ti
        WHERE ti.trade_id = p_trade_id
          AND ti.player_id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM players AS p
         JOIN nba_games AS g
           ON g.game_date = wl.game_date
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
        WHERE p.id = wl.player_id
          AND (
            g.status IN ('InProgress', 'Final')
            OR (g.game_time IS NOT NULL AND g.game_time <= now())
            OR (g.started_at IS NOT NULL AND g.started_at <= now())
          )
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;
    v_to_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END;

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
        RAISE EXCEPTION 'Failed to move player asset atomically';
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
    ELSE
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically';
      END IF;
    END IF;
  END LOOP;

  FOR v_to_member IN
    SELECT v_trade.proposer_member_id
    UNION
    SELECT v_trade.recipient_member_id
  LOOP
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_to_member
       AND is_on_ir = false
       AND is_on_taxi = false;

    IF v_active_count > COALESCE(v_league.roster_size, 0) THEN
      RAISE EXCEPTION 'Trade completion would overfill a roster.';
    END IF;
  END LOOP;

  DELETE FROM trade_drop_reservations WHERE trade_id = p_trade_id;

  UPDATE trades
     SET status = 'completed',
         completed_at = now()
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_accepted_trade_atomic(uuid) TO service_role;
