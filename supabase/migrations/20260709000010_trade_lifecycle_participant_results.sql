-- Align trade lifecycle eligibility and return every routed participant.

DROP FUNCTION IF EXISTS public.process_due_accepted_trades_atomic(int);
DROP FUNCTION IF EXISTS public.expire_pending_trades_atomic(int);

CREATE OR REPLACE FUNCTION public.create_league(
  p_name           text,
  p_team_name      text,
  p_auction_budget int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id      uuid := (SELECT auth.uid());
  v_slug         text;
  v_invite_code  text;
  v_league_id    uuid;
  v_member_id    uuid;
  v_season_year  int;
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Ensure a profiles row exists (handles dashboard-created users and signup failures)
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    SELECT lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]', '', 'g'))
      INTO v_email_prefix
      FROM auth.users
     WHERE id = v_user_id;

    v_email_prefix := COALESCE(NULLIF(v_email_prefix, ''), 'user');
    IF length(v_email_prefix) < 3 THEN v_email_prefix := 'user'; END IF;
    v_username := v_email_prefix;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
      v_counter  := v_counter + 1;
      v_username := v_email_prefix || v_counter::text;
      IF v_counter > 999 THEN EXIT; END IF;
    END LOOP;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES (v_user_id, v_username, v_email_prefix)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  v_season_year := public.current_season_year_et();

  v_slug        := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
                   || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := public.generate_invite_code();

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', trim(p_team_name))
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, s.season_year, s.round, v_member_id, v_member_id
  FROM (VALUES
    (2027, 1), (2027, 2), (2027, 3),
    (2028, 1), (2028, 2), (2028, 3),
    (2029, 1), (2029, 2), (2029, 3),
    (2030, 1), (2030, 2)
  ) AS s(season_year, round);

  RETURN jsonb_build_object(
    'id',              v_league_id,
    'name',            trim(p_name),
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'setup'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_trade_completion_failure_atomic(
  p_trade_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_rows int;
  v_league_status text;
  v_is_current boolean;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'accepted'
     AND veto_window_expires_at <= now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade is not an expired accepted trade';
  END IF;

  SELECT status
    INTO v_league_status
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT is_current
    INTO v_is_current
    FROM league_seasons
   WHERE id = v_trade.league_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade season not found.';
  END IF;

  IF v_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Trades require the current season.';
  END IF;

  IF v_league_status = 'archived' THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  DELETE FROM trade_drop_reservations
   WHERE trade_id = p_trade_id;

  UPDATE trades
     SET status = 'expired',
         completed_at = NULL,
         completion_failure_reason = p_reason
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to expire accepted trade';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_multi_team_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid,
  p_drop_roster_player_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
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
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
  v_incoming_players int;
  v_outgoing_players int;
  v_required_drops int;
  v_all_accepted boolean;
  v_veto_window_hours int;
  v_item_faab_amount int;
  v_balance int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_trade.is_multi_team, false) = false THEN
    RAISE EXCEPTION 'This trade is not a multi-team offer.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN jsonb_build_object(
      'expired', true,
      'allAccepted', false,
      'proposerMemberId', v_trade.proposer_member_id,
      'recipientMemberId', v_trade.recipient_member_id,
      'participantMemberIds', (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      )
    );
  END IF;

  PERFORM 1
    FROM trade_participants
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can accept this trade.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND member_id = p_accepting_member_id
       AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This participant has already accepted the trade.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_member_lock IN
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
     ORDER BY participant.member_id ASC
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
      COALESCE(item.from_member_id, CASE
        WHEN item.side = 'proposer' THEN v_trade.proposer_member_id
        ELSE v_trade.recipient_member_id
      END),
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);

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
           AND COALESCE(
             accepted_item.from_member_id,
             CASE WHEN accepted_item.side = 'proposer' THEN accepted_trade.proposer_member_id ELSE accepted_trade.recipient_member_id END
           ) = v_from_member
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
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
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
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
     AND COALESCE(to_member_id, CASE WHEN side = 'proposer' THEN v_trade.recipient_member_id ELSE v_trade.proposer_member_id END) = p_accepting_member_id
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND COALESCE(from_member_id, CASE WHEN side = 'proposer' THEN v_trade.proposer_member_id ELSE v_trade.recipient_member_id END) = p_accepting_member_id
     AND player_id IS NOT NULL;

  v_required_drops := GREATEST(v_active_count - v_outgoing_players + v_incoming_players - COALESCE(v_league.roster_size, 0), 0);
  IF cardinality(v_drop_ids) <> v_required_drops THEN
    RAISE EXCEPTION 'Accepting this trade requires exactly % active roster drop(s).', v_required_drops;
  END IF;

  DELETE FROM trade_drop_reservations
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id;

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

  UPDATE trade_participants
     SET accepted_at = now()
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
     AND accepted_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record participant acceptance.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND accepted_at IS NULL
  )
    INTO v_all_accepted;

  IF v_all_accepted THEN
    v_veto_window_hours := CASE
      WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
      ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
    END;

    UPDATE trades
       SET status = 'accepted',
           accepted_at = now(),
           veto_window_expires_at = CASE
             WHEN v_veto_window_hours = 0 THEN now() - interval '1 microsecond'
             ELSE now() + make_interval(hours => v_veto_window_hours)
           END,
           completed_at = NULL,
           vetoed_at = NULL
     WHERE id = p_trade_id
       AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to accept trade atomically';
    END IF;

    IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled'
       OR v_veto_window_hours = 0 THEN
      PERFORM public.complete_accepted_trade_atomic(p_trade_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'expired', false,
    'allAccepted', v_all_accepted,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  participant_member_ids uuid[],
  status text,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200);
  v_trade record;
  v_error_code text;
  v_error_message text;
BEGIN
  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id,
      ARRAY(
        SELECT participant.member_id
          FROM public.trade_participants AS participant
         WHERE participant.trade_id = trade.id
         ORDER BY participant.sort_order, participant.member_id
      ) AS participant_member_ids
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status <> 'archived'::public.league_status
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        CASE
          WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
          ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
        END,
        'completed'::text,
        NULL::text,
        NULL::text;
    EXCEPTION WHEN OTHERS THEN
      v_error_code := SQLSTATE;
      v_error_message := SQLERRM;

      IF v_error_code = 'PT001' THEN
        PERFORM public.expire_trade_completion_failure_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'expired_terminal_failure'::text,
          v_error_code,
          v_error_message;
      ELSE
        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
      END IF;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_pending_trades_atomic(
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  participant_member_ids uuid[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
BEGIN
  RETURN QUERY
  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status
     WHERE trade.id IN (
       SELECT pending.id
         FROM trades AS pending
        WHERE pending.status = 'pending'::trade_status
          AND pending.expires_at IS NOT NULL
          AND pending.expires_at <= now()
        ORDER BY pending.expires_at, pending.proposed_at, pending.id
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
     )
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  ),
  logged AS (
    INSERT INTO league_activity (
      league_id,
      league_season_id,
      actor_member_id,
      target_member_id,
      related_trade_id,
      event_type,
      title
    )
    SELECT
      expired.league_id,
      expired.league_season_id,
      expired.proposer_member_id,
      expired.recipient_member_id,
      expired.id,
      'trade_expired',
      'Trade offer expired'
    FROM expired
    RETURNING id
  )
  SELECT
    expired.id,
    expired.proposer_member_id,
    expired.recipient_member_id,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM trade_participants AS participant WHERE participant.trade_id = expired.id
      ) THEN ARRAY(
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = expired.id
         ORDER BY participant.sort_order, participant.member_id
      )
      ELSE ARRAY[expired.proposer_member_id, expired.recipient_member_id]
    END
    FROM expired;
END;
$$;

CREATE OR REPLACE FUNCTION public.veto_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_is_commissioner boolean;
  v_is_trade_party boolean;
  v_member_veto_count int;
  v_eligible_count int;
  v_threshold int;
  v_vetoed boolean;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'accepted'::trade_status THEN
    RAISE EXCEPTION 'This trade is not in its veto window.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at <= now() THEN
    RAISE EXCEPTION 'The veto window has expired.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN
    RAISE EXCEPTION 'Trade vetoes are disabled for this league.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_trade.league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_is_commissioner := v_member.role IN ('commissioner'::league_member_role, 'co_commissioner'::league_member_role);
  v_is_trade_party := v_member.id IN (v_trade.proposer_member_id, v_trade.recipient_member_id)
    OR EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = v_member.id
    );

  IF v_is_trade_party THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' AND NOT v_is_commissioner THEN
    RAISE EXCEPTION 'Only commissioners can veto trades in this league.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO trade_vetos (
      trade_id,
      member_id,
      veto_type
    )
    VALUES (
      p_trade_id,
      p_member_id,
      CASE WHEN v_is_commissioner THEN 'commissioner'::veto_type ELSE 'member'::veto_type END
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You have already vetoed this trade.'
      USING ERRCODE = '23505';
  END;

  SELECT count(*)
    INTO v_member_veto_count
    FROM trade_vetos
   WHERE trade_id = p_trade_id
     AND veto_type = 'member'::veto_type;

  SELECT count(*)
    INTO v_eligible_count
    FROM league_members AS member
   WHERE member.league_id = v_trade.league_id
     AND member.id <> v_trade.proposer_member_id
     AND member.id <> v_trade.recipient_member_id
     AND NOT EXISTS (
       SELECT 1
         FROM trade_participants AS participant
        WHERE participant.trade_id = p_trade_id
          AND participant.member_id = member.id
     );

  v_threshold := GREATEST(1, CEIL(
    COALESCE(v_eligible_count, 0)::numeric *
    COALESCE(v_league.trade_veto_threshold_percent, 50)::numeric / 100
  )::int);

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' THEN
    v_vetoed := v_is_commissioner;
  ELSE
    v_vetoed := v_is_commissioner OR COALESCE(v_member_veto_count, 0) >= v_threshold;
  END IF;

  IF v_vetoed THEN
    UPDATE trades
       SET status = 'vetoed'::trade_status,
           vetoed_at = now()
     WHERE id = p_trade_id
       AND status = 'accepted'::trade_status;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to veto trade atomically.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'vetoed', v_vetoed,
    'vetoCount', COALESCE(v_member_veto_count, 0),
    'threshold', v_threshold,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', COALESCE(
      (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ),
      jsonb_build_array(v_trade.proposer_member_id, v_trade.recipient_member_id)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_accepted_trades_atomic(int) TO service_role;
REVOKE ALL ON FUNCTION public.expire_pending_trades_atomic(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_trades_atomic(int) TO service_role;
