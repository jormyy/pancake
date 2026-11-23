INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT trade.id, party.member_id, party.sort_order, party.sort_order = 0,
  CASE
    WHEN party.sort_order = 0 THEN trade.proposed_at
    WHEN trade.status IN ('accepted'::public.trade_status, 'completed'::public.trade_status, 'vetoed'::public.trade_status)
      THEN COALESCE(trade.accepted_at, trade.proposed_at)
  END
  FROM public.trades AS trade
  CROSS JOIN LATERAL (VALUES (trade.proposer_member_id, 0), (trade.recipient_member_id, 1)) AS party(member_id, sort_order)
 WHERE party.member_id IS NOT NULL
ON CONFLICT (trade_id, member_id) DO NOTHING;

-- Canonical SQL source for private.begin_trade_action.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.begin_trade_action(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_member_ids uuid[] DEFAULT '{}',
  p_player_ids uuid[] DEFAULT '{}'
)
RETURNS public.trades
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_member_id uuid;
  v_player_id uuid;
  v_participant trade_participants%ROWTYPE;
  v_wait boolean := NOT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
  );
BEGIN
  IF p_trade_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('edit','counter','accept','reject','withdraw','retract','veto','plan','taxi','complete')
    OR (p_member_id IS NULL) <> (p_action = 'complete') THEN
    RAISE EXCEPTION 'Unsupported trade action.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.' USING ERRCODE = 'P0002';
  END IF;

  FOR v_member_id IN
    SELECT key.id FROM private.trade_lock_keys(ARRAY[p_trade_id]) AS key WHERE key.kind = 1
    UNION SELECT unnest(p_member_ids)
    ORDER BY 1
  LOOP
    CONTINUE WHEN v_member_id IS NULL;
    IF v_wait THEN
      PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_id::text));
      v_wait := false;
    ELSIF NOT pg_try_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_id::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END IF;
  END LOOP;

  FOR v_player_id IN
    SELECT key.id FROM private.trade_lock_keys(ARRAY[p_trade_id]) AS key WHERE key.kind = 2
    UNION SELECT unnest(p_player_ids)
    ORDER BY 1
  LOOP
    CONTINUE WHEN v_player_id IS NULL;
    IF v_wait THEN
      PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player_id::text));
      v_wait := false;
    ELSIF NOT pg_try_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player_id::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END IF;
  END LOOP;

  BEGIN
    PERFORM 1 FROM league_members
     WHERE id = p_member_id
       AND league_id = v_trade.league_id
       AND (p_user_id IS NULL OR user_id = p_user_id)
     FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
  END;
  IF p_member_id IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'plan' THEN 'Only the receiving manager can choose placements and drops.'
      ELSE 'Not authorized to act for this member.'
    END USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR NO KEY UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
    IF v_trade.status = 'pending' OR p_action NOT IN ('accept','reject','retract','edit','counter','taxi') THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END IF;
  END;

  SELECT * INTO v_participant FROM trade_participants WHERE trade_id = p_trade_id AND member_id = p_member_id;

  IF p_action IN ('accept', 'retract') AND v_participant.member_id IS NULL THEN
    RAISE EXCEPTION 'Only a trade participant can % this trade.', p_action USING ERRCODE = '42501';
  ELSIF p_action = 'plan' AND v_participant.member_id IS NULL THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  ELSIF p_action = 'taxi' AND NOT EXISTS (
    SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id
  ) THEN
    RAISE EXCEPTION 'This member receives no assets in this trade.' USING ERRCODE = '42501';
  ELSIF p_action IN ('withdraw', 'edit') AND v_trade.proposer_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'withdraw' THEN 'Only the trade proposer can withdraw this trade.'
      ELSE 'Only the proposer can edit this offer.'
    END USING ERRCODE = '42501';
  ELSIF p_action IN ('reject', 'counter') AND (v_participant.member_id IS NULL OR v_participant.is_initiator
    OR (v_trade.status = 'pending' AND v_participant.accepted_at IS NOT NULL)) THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'reject' THEN 'Only a non-proposer trade participant can reject this trade.'
      ELSE 'Only a non-proposer trade participant can counter this offer.'
    END USING ERRCODE = '42501';
  ELSIF p_action = 'veto' AND v_participant.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_trade;
END;
$$;

-- Canonical SQL source for private.can_read_trade.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.can_read_trade(p_trade_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.trades AS trade
     WHERE trade.id = p_trade_id
       AND trade.league_id IN (SELECT private.my_league_ids())
       AND (
         trade.status IN ('accepted'::public.trade_status, 'completed'::public.trade_status)
         OR EXISTS (
           SELECT 1
             FROM public.trade_participants AS participant
            WHERE participant.trade_id = trade.id
              AND participant.member_id IN (SELECT private.my_member_ids())
         )
       )
  )
$$;

-- Canonical SQL source for private.create_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.create_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_offer_player_ids uuid[] := COALESCE(p_offer_player_ids, ARRAY[]::uuid[]);
  v_request_player_ids uuid[] := COALESCE(p_request_player_ids, ARRAY[]::uuid[]);
  v_offer_pick_ids uuid[] := COALESCE(p_offer_pick_ids, ARRAY[]::uuid[]);
  v_request_pick_ids uuid[] := COALESCE(p_request_pick_ids, ARRAY[]::uuid[]);
  v_offer_faab_amount int := COALESCE(p_offer_faab_amount, 0);
  v_request_faab_amount int := COALESCE(p_request_faab_amount, 0);
  v_rows int;
  v_league leagues%ROWTYPE;
  v_terms jsonb;
  v_champion_finalized boolean := false;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF cardinality(v_offer_player_ids) + cardinality(v_request_player_ids) +
     cardinality(v_offer_pick_ids) + cardinality(v_request_pick_ids) +
     (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) +
     (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) > 100 THEN
    RAISE EXCEPTION 'A trade cannot include more than 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  IF p_proposer_member_id = p_recipient_member_id THEN
    RAISE EXCEPTION 'You cannot trade with yourself.';
  END IF;

  IF v_offer_faab_amount < 0 OR v_offer_faab_amount > 1000000 OR
     v_request_faab_amount < 0 OR v_request_faab_amount > 1000000 THEN
    RAISE EXCEPTION 'FAAB trade amounts must be between 0 and 1000000.'
      USING ERRCODE = '22023';
  END IF;

  IF cardinality(v_offer_player_ids) + cardinality(v_offer_pick_ids) + (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) = 0 OR
     cardinality(v_request_player_ids) + cardinality(v_request_pick_ids) + (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) = 0 THEN
    RAISE EXCEPTION 'A trade must include at least one asset on each side.';
  END IF;

  IF (SELECT count(*) FROM unnest(v_offer_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_offer_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered picks are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested picks are not allowed.';
  END IF;

  PERFORM private.lock_trade_offer_assets(
    p_league_id,
    ARRAY[p_proposer_member_id, p_recipient_member_id],
    v_offer_player_ids || v_request_player_ids
  );

  SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
    'fromMemberId',route.sender,'toMemberId',route.receiver,'playerId',route.player_id,
    'pickId',route.pick_id,'faabAmount',route.faab_amount))) INTO v_terms
  FROM (
    SELECT p_proposer_member_id sender,p_recipient_member_id receiver,player_id,NULL::uuid pick_id,0 faab_amount FROM unnest(v_offer_player_ids) player_id
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,player_id,NULL::uuid,0 FROM unnest(v_request_player_ids) player_id
    UNION ALL SELECT p_proposer_member_id,p_recipient_member_id,NULL::uuid,pick_id,0 FROM unnest(v_offer_pick_ids) pick_id
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,NULL::uuid,pick_id,0 FROM unnest(v_request_pick_ids) pick_id
    UNION ALL SELECT p_proposer_member_id,p_recipient_member_id,NULL::uuid,NULL::uuid,v_offer_faab_amount WHERE v_offer_faab_amount>0
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,NULL::uuid,NULL::uuid,v_request_faab_amount WHERE v_request_faab_amount>0
  ) route;
  IF EXISTS(SELECT 1 FROM trades pending WHERE pending.league_id=p_league_id
    AND pending.league_season_id=p_league_season_id AND pending.status='pending'
    AND (pending.expires_at IS NULL OR pending.expires_at>now())
    AND pending.proposer_member_id=p_proposer_member_id
    AND EXISTS(SELECT 1 FROM trade_participants party WHERE party.trade_id=pending.id AND party.member_id=p_recipient_member_id)
    AND pending.id IS DISTINCT FROM p_edited_from_trade_id AND pending.id IS DISTINCT FROM p_countered_from_trade_id
    AND v_terms=(SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
      'fromMemberId',item.from_member_id,'toMemberId',item.to_member_id,'playerId',item.player_id,
      'pickId',item.pick_id,'faabAmount',item.faab_amount))) FROM trade_items item WHERE item.trade_id=pending.id)) THEN
    RAISE EXCEPTION 'An identical offer is already pending. Open that trade instead.' USING ERRCODE='P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  PERFORM private.assert_trade_window(p_league_id, v_offer_pick_ids || v_request_pick_ids);

  IF v_league.status NOT IN (
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF (v_offer_faab_amount > 0 OR v_request_faab_amount > 0) AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;


  PERFORM 1
    FROM league_members
   WHERE id = p_proposer_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposer not found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_recipient_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient not found.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_proposer_member_id
       AND player_id = ANY(v_offer_player_ids)
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (is_on_ir = false AND is_on_taxi = false))
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_player_ids) THEN
    RAISE EXCEPTION 'Your offer includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_recipient_member_id
       AND player_id = ANY(v_request_player_ids)
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (is_on_ir = false AND is_on_taxi = false))
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_player_ids) THEN
    RAISE EXCEPTION 'Your request includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_proposer_member_id
       AND is_used = false
       AND id = ANY(v_offer_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_pick_ids) THEN
    RAISE EXCEPTION 'Your offer includes a draft pick that is no longer owned by the expected team.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_recipient_member_id
       AND is_used = false
       AND id = ANY(v_request_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_pick_ids) THEN
    RAISE EXCEPTION 'Your request includes a draft pick that is no longer owned by the expected team.';
  END IF;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version,
    proposer_faab_amount,
    recipient_faab_amount
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    GREATEST(COALESCE(p_version, 1), 1),
    v_offer_faab_amount,
    v_request_faab_amount
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_items (trade_id, side, player_id, pick_id, from_member_id, to_member_id, faab_amount)
  SELECT v_trade_id, 'proposer'::trade_side, player_id, NULL::uuid, p_proposer_member_id, p_recipient_member_id, 0
    FROM unnest(v_offer_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, player_id, NULL::uuid, p_recipient_member_id, p_proposer_member_id, 0
    FROM unnest(v_request_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, pick_id, p_proposer_member_id, p_recipient_member_id, 0
    FROM unnest(v_offer_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, pick_id, p_recipient_member_id, p_proposer_member_id, 0
    FROM unnest(v_request_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, NULL::uuid, p_proposer_member_id, p_recipient_member_id, v_offer_faab_amount
   WHERE v_offer_faab_amount > 0
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, NULL::uuid, p_recipient_member_id, p_proposer_member_id, v_request_faab_amount
   WHERE v_request_faab_amount > 0;

  INSERT INTO trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
  VALUES
    (v_trade_id, p_proposer_member_id, 0, true, now()),
    (v_trade_id, p_recipient_member_id, 1, false, NULL);

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'Counteroffer sent'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'Trade offer edited'
      ELSE 'Trade offer sent'
    END,
    NULL,
    p_proposer_member_id,
    p_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'parent_trade_id', p_parent_trade_id,
      'countered_from_trade_id', p_countered_from_trade_id,
      'edited_from_trade_id', p_edited_from_trade_id,
      'version', GREATEST(COALESCE(p_version, 1), 1),
      'proposer_faab_amount', v_offer_faab_amount,
      'recipient_faab_amount', v_request_faab_amount
    )
  );

  RETURN v_trade_id;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
END;
$$;

-- Canonical SQL source for private.enqueue_trade_status_notification.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_trade_status_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_type text;
  v_title text;
  v_body text;
BEGIN
  IF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'completed'::public.trade_status THEN
    v_event_type := 'trade_completed';
    v_title := 'Trade Completed';
    v_body := 'Assets have moved. Check your roster.';
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'rejected'::public.trade_status THEN
    v_event_type := 'trade_rejected';
    v_title := 'Trade Rejected';
    v_body := 'Your trade offer was declined.';
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'withdrawn'::public.trade_status THEN
    v_event_type := 'trade_withdrawn';
    v_title := 'Trade Withdrawn';
    IF NEW.completion_failure_reason IN ('A player in this offer was traded','An asset in this offer was traded') THEN
      v_title := 'Trade Cancelled';
      v_body := NEW.completion_failure_reason;
      ELSE
      v_body := 'A trade offer sent to you has been withdrawn.';
    END IF;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'expired'::public.trade_status THEN
    v_event_type := 'trade_expired';
    v_title := 'Trade Expired';
    v_body := 'One of your pending trade offers expired.';
  ELSIF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'vetoed'::public.trade_status THEN
    v_event_type := 'trade_vetoed';
    v_title := 'Trade Vetoed';
    v_body := 'An accepted trade was vetoed before completion.';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notification_outbox (
    dedupe_key,
    member_id,
    event_type,
    title,
    body,
    data,
    category
  )
  SELECT
    format('%s:%s:%s', v_event_type, NEW.id, recipient.member_id),
    recipient.member_id,
    v_event_type,
    v_title,
    v_body,
    jsonb_build_object('tradeId', NEW.id, 'leagueId', NEW.league_id),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.id
       AND (v_event_type <> 'trade_withdrawn' OR participant.member_id <> NEW.proposer_member_id
         OR NEW.completion_failure_reason IN ('A player in this offer was traded','An asset in this offer was traded'))
       AND (v_event_type <> 'trade_rejected' OR participant.member_id = NEW.proposer_member_id OR participant.accepted_at IS NOT NULL)
  ) AS recipient
  WHERE EXISTS (SELECT 1 FROM public.league_members member WHERE member.id = recipient.member_id AND member.league_id = NEW.league_id)
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

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
      AND source.id IN (v_trade.edited_from_trade_id,v_trade.countered_from_trade_id)
      AND (source.proposer_member_id=v_trade.proposer_member_id) = (source.id IS NOT DISTINCT FROM v_trade.edited_from_trade_id)
      AND EXISTS (SELECT 1 FROM trade_participants party WHERE party.trade_id=source.id AND party.member_id=v_trade.proposer_member_id)
      AND EXISTS (SELECT 1 FROM trade_participants party WHERE party.trade_id=source.id AND party.member_id=v_member));
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

-- Canonical SQL source for private.is_trade_party.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.is_trade_party(p_trade_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.trades AS trade
     WHERE trade.id = p_trade_id
       AND trade.league_id IN (SELECT private.my_league_ids())
       AND EXISTS (
         SELECT 1
           FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id IN (SELECT private.my_member_ids())
       )
  )
$$;

-- Canonical SQL source for private.prevent_expired_or_unfunded_trade_accept.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_expired_or_unfunded_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender record;
BEGIN
  IF OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status THEN
    IF OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'This trade offer has expired.'
        USING ERRCODE = 'P0001';
    END IF;

    FOR v_sender IN
      SELECT item.from_member_id AS member_id, sum(item.faab_amount) AS amount
        FROM trade_items AS item
       WHERE item.trade_id = OLD.id AND item.faab_amount > 0
       GROUP BY item.from_member_id
       ORDER BY item.from_member_id
    LOOP
      IF private.ensure_faab_balance(OLD.league_id, OLD.league_season_id, v_sender.member_id) < v_sender.amount THEN
        RAISE EXCEPTION '%', CASE WHEN v_sender.member_id = OLD.proposer_member_id
          THEN 'Proposer no longer has enough FAAB for this trade.'
          ELSE 'Recipient no longer has enough FAAB for this trade.' END
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- Canonical SQL source for private.replace_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.replace_trade_offer(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_new_trade_id uuid;
  v_parent_trade_id uuid;
  v_new_recipient_member_id uuid;
  v_replaced_status trade_status;
  v_countered_from_trade_id uuid := NULL;
  v_edited_from_trade_id uuid := NULL;
  v_pending_error text;
BEGIN
  IF p_action NOT IN ('counter', 'edit') THEN
    RAISE EXCEPTION 'Unsupported trade replacement action.'
      USING ERRCODE = '22023';
  END IF;

  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, p_action, '{}',
    COALESCE(p_offer_player_ids, '{}') || COALESCE(p_request_player_ids, '{}'));

  IF COALESCE(v_trade.is_multi_team, false) THEN
    RAISE EXCEPTION 'Use the multi-team action for this trade.' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'counter' THEN
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
  ELSE
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
  END IF;

  v_parent_trade_id := COALESCE(v_trade.parent_trade_id, v_trade.id);
  SELECT member_id INTO STRICT v_new_recipient_member_id
    FROM trade_participants WHERE trade_id = p_trade_id AND member_id <> p_member_id;

  v_new_trade_id := private.create_trade_offer(
    v_trade.league_id,
    v_trade.league_season_id,
    p_member_id,
    v_new_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    v_parent_trade_id,
    v_countered_from_trade_id,
    v_edited_from_trade_id,
    v_trade.version + 1
  );

  UPDATE trades
     SET status = v_replaced_status,
         replaced_by_trade_id = v_new_trade_id
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status;

  RETURN v_new_trade_id;
END;
$$;

-- Canonical SQL source for private.trade_lock_keys.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_lock_keys(p_trade_ids uuid[])
RETURNS TABLE (league_id uuid, kind int, id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT trade.league_id, key.kind, key.id
    FROM trades AS trade
    CROSS JOIN LATERAL (
      SELECT 1, participant.member_id FROM trade_participants AS participant WHERE participant.trade_id = trade.id
      UNION SELECT 2, item.player_id FROM trade_items AS item WHERE item.trade_id = trade.id
      UNION SELECT 2, unnest(participant.drop_player_ids) FROM trade_participants AS participant WHERE participant.trade_id = trade.id
      UNION SELECT 2, (move->>'playerId')::uuid
        FROM trade_participants AS participant, jsonb_array_elements(participant.roster_moves) AS move
       WHERE participant.trade_id = trade.id
    ) AS key(kind, id)
   WHERE trade.id = ANY(p_trade_ids)
     AND key.id IS NOT NULL;
$$;

-- Canonical SQL source for public.expire_pending_trades_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
    ARRAY(
      SELECT participant.member_id
        FROM trade_participants AS participant
       WHERE participant.trade_id = expired.id
       ORDER BY participant.sort_order, participant.member_id
    )
    FROM expired;
END;
$$;

-- Canonical SQL source for public.expire_trade_completion_failure_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_reason text := COALESCE(NULLIF(BTRIM(p_reason), ''), 'The accepted trade could not be completed.');
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

  UPDATE trades
     SET status = 'expired',
         completed_at = NULL,
         completion_failure_reason = v_reason
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to expire accepted trade';
  END IF;

  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_trade_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    v_trade.league_id,
    v_trade.league_season_id,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    v_trade.id,
    'trade_completion_failed',
    'Accepted trade expired',
    v_reason,
    jsonb_build_object('reason', v_reason, 'terminal', true)
  );

  INSERT INTO notification_outbox (
    dedupe_key,
    member_id,
    event_type,
    title,
    body,
    data,
    category
  )
  SELECT
    format('trade_terminal_failure:%s:%s', v_trade.id, recipient.member_id),
    recipient.member_id,
    'trade_completion_failed',
    'Accepted Trade Expired',
    'An accepted trade could not be completed. Check the trade activity for details.',
    jsonb_build_object('tradeId', v_trade.id, 'reason', v_reason),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = v_trade.id
  ) AS recipient
  ON CONFLICT (dedupe_key) DO NOTHING;
END;
$$;

-- Canonical SQL source for public.get_trade_cards.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_cards(p_league_id uuid,p_member_id uuid,p_trade_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE cards jsonb; current_year integer:=public.current_season_year_et(); teams integer;
BEGIN
  PERFORM public.view_context(p_league_id,p_member_id);
  IF p_trade_ids IS NULL OR cardinality(p_trade_ids)>100 THEN
    RAISE EXCEPTION 'Choose at most 100 trades.' USING ERRCODE='22023';
  END IF;
  IF cardinality(p_trade_ids)=0 THEN RETURN '[]'::jsonb; END IF;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=p_league_id;
  WITH own_members AS MATERIALIZED (
    SELECT id FROM public.league_members WHERE league_id=p_league_id AND user_id=auth.uid()
  ), requested AS MATERIALIZED (
    SELECT id,ordinal FROM unnest(p_trade_ids) WITH ORDINALITY row(id,ordinal)
  ), chosen AS MATERIALIZED (
    SELECT trade.* FROM public.trades trade WHERE trade.league_id=p_league_id AND trade.id=ANY(p_trade_ids)
      AND (trade.status IN ('accepted','completed')
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=trade.id
          AND participant.member_id IN(SELECT id FROM own_members)))
  ), cached_values AS MATERIALIZED (
    SELECT cached.trade_id, value.* FROM chosen trade
    JOIN public.trade_value_cache cached ON cached.trade_id=trade.id
    CROSS JOIN LATERAL jsonb_to_record(CASE WHEN jsonb_typeof(cached.revaluation)='object'
      THEN cached.revaluation ELSE '{}'::jsonb END)
      value("modelVersion" text,"inputVersion" text,"createdAt" text,analysis jsonb)
    WHERE value."modelVersion"='onenumber-trade-curve-v6'
  ), participants AS (
    SELECT participant.trade_id,COALESCE(jsonb_agg(jsonb_build_object('memberId',participant.member_id,
      'teamName',COALESCE(member.team_name,'Unknown'),'sortOrder',participant.sort_order,
      'isInitiator',participant.is_initiator,'acceptedAt',participant.accepted_at,
      'dropPlayerIds',participant.drop_player_ids,'rosterMoves',participant.roster_moves)
      ORDER BY participant.sort_order,member.team_name,participant.member_id),'[]') AS value
    FROM chosen trade JOIN public.trade_participants participant ON participant.trade_id=trade.id
    LEFT JOIN public.league_members member ON member.id=participant.member_id AND member.league_id=p_league_id
    GROUP BY participant.trade_id
  ), pick_values AS MATERIALIZED (
    SELECT value.* FROM public.get_dynasty_pick_values(p_league_id) value
    WHERE EXISTS(SELECT 1 FROM chosen trade JOIN public.trade_items item ON item.trade_id=trade.id
      JOIN public.draft_picks pick ON pick.id=item.pick_id WHERE pick.predicted_trade_value IS NULL)
  ), player_data AS MATERIALIZED (
    SELECT player.id,player.display_name,player.position,player.eligible_positions,player.nba_team,player.nba_id,
      player.injury_status,player.years_exp,player.nba_draft_number,player.career_regular_season_games,
      (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
        AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1) AS trade_value,
      COALESCE(average.avg_fantasy_points,source_fantasy.avg_fantasy_points) AS avg_fantasy_points,
      COALESCE(average.averages->'avg_minutes_played',to_jsonb(source_average.avg_minutes_played)) AS avg_minutes_played
    FROM (SELECT DISTINCT item.player_id FROM chosen trade JOIN public.trade_items item ON item.trade_id=trade.id
      WHERE item.player_id IS NOT NULL) selected
    JOIN public.players player ON player.id=selected.player_id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = player.id
      AND average.season_year = current_year
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = player.id
      AND source_average.season_year = current_year
    LEFT JOIN LATERAL (
      SELECT fantasy.avg_fantasy_points FROM public.v_player_avg_fantasy_points fantasy
      WHERE average.player_id IS NULL AND fantasy.league_id=p_league_id
        AND fantasy.player_id=player.id AND fantasy.season_year=current_year
      OFFSET 0
    ) source_fantasy ON true
  ), items AS (
    SELECT item.trade_id, COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'tradeValue', player.trade_value,
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', player.avg_fantasy_points,
      'avgMinutesPlayed', player.avg_minutes_played)
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'tradeValue', COALESCE(pick.predicted_trade_value,(SELECT value.trade_value FROM pick_values value
        WHERE value.draft_year=pick.season_year AND value.round=pick.round AND value.tier=CASE
          WHEN slot.pick_in_round IS NULL THEN 'mid'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)/3.0) THEN 'early'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)*2/3.0) THEN 'mid'
          ELSE 'late' END)),
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
    AS value FROM public.trade_items item JOIN chosen trade ON trade.id=item.trade_id LEFT JOIN player_data player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id AND pick.league_id=p_league_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id AND original.league_id=p_league_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id

    GROUP BY item.trade_id

  )
  SELECT COALESCE(jsonb_agg(CASE WHEN trade.id IS NOT NULL THEN jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', COALESCE(participants.value,'[]'::jsonb), 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', COALESCE(items.value,'[]'::jsonb), 'estimate', CASE WHEN quote.id IS NOT NULL OR cached.trade_id IS NOT NULL THEN jsonb_build_object('quoteId',quote.id,'modelVersion',COALESCE(cached."modelVersion",quote.model_version),'inputVersion',COALESCE(cached."inputVersion",quote.input_version),'createdAt',COALESCE(cached."createdAt",quote.created_at::text),'teams',COALESCE(cached.analysis->'teams',quote.analysis->'teams'),'assets',COALESCE(cached.analysis->'assets',quote.analysis->'assets')) END, 'estimateUnavailable', recorded.unavailable_reason) END ORDER BY requested.ordinal),'[]')
  INTO cards FROM requested LEFT JOIN chosen trade ON trade.id=requested.id
    LEFT JOIN participants ON participants.trade_id=trade.id LEFT JOIN items ON items.trade_id=trade.id
    LEFT JOIN public.trade_estimates recorded ON recorded.trade_id=trade.id
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id=recorded.quote_id
    LEFT JOIN cached_values cached ON cached.trade_id=trade.id;
  RETURN cards;
END;
$$;

-- Canonical SQL source for public.process_due_accepted_trades_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_trade_ids uuid[];
  v_asset record;
  v_error_code text;
  v_error_message text;
BEGIN
  SELECT COALESCE(array_agg(due.id), ARRAY[]::uuid[]) INTO v_trade_ids
  FROM (
    SELECT trade.id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  ) AS due;

  FOR v_asset IN
    SELECT key.league_id, key.id FROM private.trade_lock_keys(v_trade_ids) AS key
     ORDER BY key.league_id, key.kind, key.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.id::text));
  END LOOP;

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
    WHERE trade.id = ANY(v_trade_ids)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        v_trade.participant_member_ids,
        CASE WHEN EXISTS(SELECT 1 FROM trades WHERE id=v_trade.id AND jsonb_array_length(legality_issues)>0) THEN 'deferred' ELSE 'completed' END::text,
        NULL::text,
        NULL::text;
    EXCEPTION
      WHEN SQLSTATE 'PA010' OR SQLSTATE 'PT409' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        PERFORM public.hold_trade_for_legality_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          v_trade.participant_member_ids,
          'deferred'::text,
          v_error_code,
          v_error_message;
      WHEN SQLSTATE 'PA011' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          v_trade.participant_member_ids,
          'deferred'::text,
          v_error_code,
          v_error_message;
      WHEN serialization_failure OR deadlock_detected OR lock_not_available THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          v_trade.participant_member_ids,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
    END;
  END LOOP;
END;
$$;

-- Canonical SQL source for public.submit_trade_offer_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
  v_member_league uuid;
  v_multi boolean := p_action LIKE '%-multi';
  v_source uuid;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  IF p_action NOT LIKE 'propose%' THEN
    v_source := (p_payload->>'tradeId')::uuid;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'The source trade is required.' USING ERRCODE='22023';
    END IF;
  END IF;
  IF v_source IS NULL THEN
    v_member_league := private.begin_trade_offer(p_member_id, p_user_id);
  ELSE
    v_member_league := (private.begin_trade_action(v_source, p_member_id, p_user_id, split_part(p_action,'-',1),
      ARRAY[p_member_id, (p_payload->>'recipientMemberId')::uuid] || CASE WHEN v_multi
        THEN ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[]
        ELSE '{}' END,
      CASE WHEN v_multi
        THEN ARRAY(SELECT (item->>'playerId')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) AS items(item))
        ELSE ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[]
          || ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[]
      END)).league_id;
  END IF;
  BEGIN
    __request_context := private.request_begin('public.submit_trade_offer_atomic', jsonb_build_array(p_user_id, p_request_id, p_member_id, p_action, p_payload - 'estimateId'), p_request_id, NULL, p_user_id);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF EXISTS (
      SELECT 1 FROM private.request_receipts
      WHERE request_id=p_request_id AND actor IS DISTINCT FROM p_user_id
    ) OR EXISTS (
      SELECT 1 FROM private.trade_offer_requests
      WHERE user_id=p_user_id AND request_id=p_request_id AND member_id IS DISTINCT FROM p_member_id
    ) THEN
      RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
    END IF;
    RAISE;
  END;
  IF EXISTS (
    SELECT 1 FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id AND member_id IS DISTINCT FROM p_member_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
  END IF;
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
  v_league uuid;
  v_season uuid;
  v_recipient uuid;
  v_notes text;
  v_expiration timestamptz;
  v_offer_players uuid[];
  v_request_players uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_offer_faab int;
  v_request_faab int;
  v_participants uuid[];
  v_items jsonb;
  v_envelope jsonb;
  v_receipt private.trade_offer_requests%ROWTYPE;
  v_inserted int;
  v_result uuid;
  v_plans jsonb; v_check_items jsonb; v_check_teams jsonb; v_check_error text; v_plan_entry record;
BEGIN
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlans' THEN v_envelope:=v_envelope||jsonb_build_object('rosterPlans',p_payload->'rosterPlans'); END IF;
  IF p_payload ? 'rosterPlan' THEN v_envelope := v_envelope||jsonb_build_object('rosterPlan',p_payload->'rosterPlan'); END IF;
  IF p_action IN ('propose','propose-multi') THEN
    v_league := (p_payload->>'leagueId')::uuid;
    v_season := (p_payload->>'leagueSeasonId')::uuid;
    IF v_league IS DISTINCT FROM v_member_league OR v_season IS NULL THEN
      RAISE EXCEPTION 'The offer must use this member''s league and a season.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
    IF NOT v_multi THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  ELSE
    v_envelope := v_envelope||jsonb_build_object('tradeId',v_source);
    IF NOT v_multi AND p_payload ? 'recipientMemberId' THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  END IF;
  IF v_multi THEN
    v_participants := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[];
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
      'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
      'faabAmount',COALESCE((item->>'faabAmount')::int,0)) ORDER BY ordinal),'[]'::jsonb)
      INTO v_items FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) WITH ORDINALITY AS items(item,ordinal);
    v_envelope := v_envelope||jsonb_build_object('participantMemberIds',v_participants,'items',v_items);
  ELSE
    v_offer_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[];
    v_request_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[];
    v_offer_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPickIds','[]'::jsonb)))::uuid[];
    v_request_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPickIds','[]'::jsonb)))::uuid[];
    v_offer_faab := COALESCE((p_payload->>'offerFaabAmount')::int,0);
    v_request_faab := COALESCE((p_payload->>'requestFaabAmount')::int,0);
    v_envelope := v_envelope||jsonb_build_object('offerPlayerIds',v_offer_players,'requestPlayerIds',v_request_players,
      'offerPickIds',v_offer_picks,'requestPickIds',v_request_picks,
      'offerFaabAmount',v_offer_faab,'requestFaabAmount',v_request_faab);
  END IF;

  IF v_source IS NOT NULL THEN
    SELECT league_id,league_season_id INTO v_league,v_season FROM trades WHERE id=v_source;
    IF NOT v_multi THEN
      SELECT member_id INTO v_recipient FROM trade_participants WHERE trade_id=v_source AND member_id<>p_member_id;
    END IF;
    IF NOT v_multi AND p_payload ? 'recipientMemberId'
      AND (p_payload->>'recipientMemberId')::uuid IS DISTINCT FROM v_recipient THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
  END IF;
  v_plans:=COALESCE(p_payload->'rosterPlans','{}')||jsonb_build_object(p_member_id::text,COALESCE(p_payload->'rosterPlan','{}'));
  FOR v_plan_entry IN SELECT * FROM jsonb_each(v_plans) LOOP
    IF v_plan_entry.key<>p_member_id::text AND (jsonb_array_length(COALESCE(v_plan_entry.value->'dropPlayerIds','[]'))>0 OR jsonb_array_length(COALESCE(v_plan_entry.value->'rosterMoves','[]'))>0) THEN
      RAISE EXCEPTION 'Only a team manager can choose its drops and moves.' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF v_multi THEN v_check_items:=v_items;
  ELSE
    v_participants:=ARRAY[p_member_id,v_recipient];
    SELECT COALESCE(jsonb_agg(item),'[]') INTO v_check_items FROM (
      SELECT jsonb_build_object('playerId',id,'fromMemberId',p_member_id,'toMemberId',v_recipient) item FROM unnest(v_offer_players) id
      UNION ALL SELECT jsonb_build_object('playerId',id,'fromMemberId',v_recipient,'toMemberId',p_member_id) FROM unnest(v_request_players) id
      UNION ALL SELECT jsonb_build_object('fromMemberId',p_member_id,'toMemberId',v_recipient,'faabAmount',v_offer_faab)
      UNION ALL SELECT jsonb_build_object('fromMemberId',v_recipient,'toMemberId',p_member_id,'faabAmount',v_request_faab)
    ) items;
  END IF;
  v_check_teams:=private.check_trade_legality(v_league,v_season,v_participants,v_check_items,v_plans,v_source);
  SELECT string_agg(reason->>'message',' ') INTO v_check_error FROM jsonb_array_elements(v_check_teams) team
    CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason
    WHERE team->>'memberId'=p_member_id::text;
  IF v_check_error IS NOT NULL THEN RAISE EXCEPTION '%',v_check_error USING ERRCODE='PT409',DETAIL=v_check_teams::text; END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
  END IF;
  IF v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN __request_result := v_receipt.result_trade_id; EXIT request_write; END IF;
  IF v_inserted=0 THEN
    RAISE EXCEPTION 'This trade request has no completed receipt.' USING ERRCODE='55000';
  END IF;

  IF p_action='propose' THEN
    v_result := public.propose_trade_atomic(v_league,v_season,p_member_id,v_recipient,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  ELSIF p_action='propose-multi' THEN
    v_result := public.propose_multi_team_trade_atomic(v_league,v_season,p_member_id,v_participants,v_items,v_notes,v_expiration);
  ELSIF v_multi THEN
    v_result := private.replace_multi_team_trade_offer(v_source,p_member_id,p_user_id,split_part(p_action,'-',1),
      v_participants,v_items,v_notes,v_expiration);
  ELSE
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[],
      COALESCE(p_payload->'rosterPlan'->'rosterMoves','[]'::jsonb));
  END IF;
  IF v_result IS NOT NULL THEN
    FOR v_plan_entry IN SELECT * FROM jsonb_each(v_plans) WHERE key<>p_member_id::text LOOP
      UPDATE trade_items SET to_ir=COALESCE(v_plan_entry.value->'irPlayerIds','[]') ? player_id::text,
        to_taxi=COALESCE(v_plan_entry.value->'taxiPlayerIds','[]') ? player_id::text OR EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_season AND roster_players.player_id=trade_items.player_id AND is_on_taxi)
        WHERE trade_id=v_result AND to_member_id=v_plan_entry.key::uuid AND player_id IS NOT NULL;
    END LOOP;
    PERFORM private.validate_trade_rosters(v_result,p_member_id);
    PERFORM private.attach_trade_estimate(v_result,p_member_id,(p_payload->>'estimateId')::uuid);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  __request_result := v_result; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.veto_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  __request_context jsonb;
  __request_result jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, NULL, 'veto');
  __request_context := private.request_begin('public.veto_trade_atomic', jsonb_build_array(p_trade_id, p_member_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_is_commissioner boolean;
  v_member_veto_count int;
  v_eligible_count int;
  v_threshold int;
  v_vetoed boolean;
  v_rows int;
BEGIN
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

  v_is_commissioner := v_member.role IN ('commissioner'::league_member_role, 'co_commissioner'::league_member_role);

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

  __request_result := jsonb_build_object(
    'vetoed', v_vetoed,
    'vetoCount', COALESCE(v_member_veto_count, 0),
    'threshold', v_threshold,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
    )
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
