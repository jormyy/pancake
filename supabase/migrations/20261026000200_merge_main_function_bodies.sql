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
  v_single_recipient uuid;
  v_all_participants boolean := false;
BEGIN
  IF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'completed'::public.trade_status THEN
    v_event_type := 'trade_completed';
    v_title := 'Trade Completed';
    v_body := 'Assets have moved. Check your roster.';
    v_all_participants := true;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'rejected'::public.trade_status THEN
    v_event_type := 'trade_rejected';
    v_title := 'Trade Rejected';
    v_body := 'Your trade offer was declined.';
    v_single_recipient := NEW.proposer_member_id;
    v_all_participants := COALESCE(NEW.is_multi_team, false);
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'withdrawn'::public.trade_status THEN
    v_event_type := 'trade_withdrawn';
    v_title := 'Trade Withdrawn';
    v_body := 'A trade offer sent to you has been withdrawn.';
    v_all_participants := COALESCE(NEW.is_multi_team, false);
    v_single_recipient := NEW.recipient_member_id;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'expired'::public.trade_status THEN
    v_event_type := 'trade_expired';
    v_title := 'Trade Expired';
    v_body := 'One of your pending trade offers expired.';
    v_all_participants := true;
  ELSIF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'vetoed'::public.trade_status THEN
    v_event_type := 'trade_vetoed';
    v_title := 'Trade Vetoed';
    v_body := 'An accepted trade was vetoed before completion.';
    v_all_participants := true;
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
       AND v_all_participants
       AND (v_event_type <> 'trade_withdrawn' OR participant.member_id <> NEW.proposer_member_id)
       AND (v_event_type <> 'trade_rejected' OR participant.member_id = NEW.proposer_member_id OR participant.accepted_at IS NOT NULL)
    UNION SELECT v_single_recipient WHERE NOT v_all_participants
  ) AS recipient
  WHERE recipient.member_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.league_members member WHERE member.id = recipient.member_id AND member.league_id = NEW.league_id)
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.regular_season_matchup_payload(p_league_id uuid, p_season_id uuid, p_weeks int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_members uuid[];
  v_count int;
  v_round int;
  v_week int;
  v_pair int;
  v_home uuid;
  v_away uuid;
  v_played int := 0;
  v_rows jsonb := '[]'::jsonb;
  v_order int[];
  v_a int; v_b int; v_code int; v_index int; v_current int; v_next int; v_edge int;
  v_counts int[]; v_seen int[]; v_degrees int[]; v_forward boolean[];
  v_left int[] := '{}'; v_right int[] := '{}'; v_codes int[] := '{}'; v_used boolean[];
  v_raw jsonb := '[]'; v_row jsonb;
  v_modern boolean; v_previous uuid; v_previous_rows jsonb;
BEGIN
  SELECT matchup_order_version = 1 INTO v_modern FROM public.league_seasons WHERE id = p_season_id AND league_id = p_league_id;
  IF v_modern THEN
    SELECT array_agg(id ORDER BY md5(p_season_id::text || ':' || id::text), id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
    v_count := COALESCE(cardinality(v_members), 0);
    IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
    IF v_count % 2 = 1 THEN v_members := array_append(v_members, NULL::uuid); v_count := v_count + 1; END IF;
    SELECT array_agg(r ORDER BY md5(p_season_id::text || ':round:' || r::text), r) INTO v_order FROM generate_series(0, v_count - 2) r;
    v_counts := array_fill(0, ARRAY[v_count * v_count]);
    v_seen := v_counts;
    v_forward := array_fill(true, ARRAY[v_count * v_count]);
    v_degrees := array_fill(0, ARRAY[v_count]);
    FOR v_week IN 1..p_weeks LOOP
      IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;
      v_round := v_order[1 + v_played % (v_count - 1)];
      v_played := v_played + 1;
      FOR v_pair IN 0..(v_count / 2 - 1) LOOP
        v_a := CASE WHEN v_pair = 0 THEN 1 ELSE 2 + (v_pair - 1 + v_round) % (v_count - 1) END;
        v_b := 2 + (v_count - 2 - v_pair + v_round) % (v_count - 1);
        IF v_members[v_a] IS NULL OR v_members[v_b] IS NULL THEN CONTINUE; END IF;
        v_code := (LEAST(v_a,v_b)-1)*v_count + GREATEST(v_a,v_b);
        v_counts[v_code] := v_counts[v_code] + 1;
        v_raw := v_raw || jsonb_build_array(jsonb_build_object('week',v_week,'a',LEAST(v_a,v_b),'b',GREATEST(v_a,v_b),'code',v_code));
      END LOOP;
    END LOOP;
    FOR v_a IN 1..v_count LOOP
      FOR v_b IN (v_a+1)..v_count LOOP
        v_code := (v_a-1)*v_count+v_b;
        IF v_counts[v_code] % 2 = 1 THEN
          v_left := array_append(v_left,v_a); v_right := array_append(v_right,v_b); v_codes := array_append(v_codes,v_code);
          v_degrees[v_a] := v_degrees[v_a]+1; v_degrees[v_b] := v_degrees[v_b]+1;
        END IF;
      END LOOP;
    END LOOP;
    FOR v_a IN 1..v_count LOOP
      IF v_degrees[v_a] % 2 = 1 THEN
        v_left := array_append(v_left,v_a); v_right := array_append(v_right,v_count+1); v_codes := array_append(v_codes,0);
      END IF;
    END LOOP;
    v_used := array_fill(false,ARRAY[cardinality(v_left)]);
    FOR v_index IN 1..cardinality(v_left) LOOP
      IF v_used[v_index] THEN CONTINUE; END IF;
      v_current := v_left[v_index];
      LOOP
        v_edge := NULL;
        FOR v_pair IN 1..cardinality(v_left) LOOP
          IF NOT v_used[v_pair] AND (v_left[v_pair]=v_current OR v_right[v_pair]=v_current) THEN v_edge:=v_pair; EXIT; END IF;
        END LOOP;
        EXIT WHEN v_edge IS NULL;
        v_used[v_edge] := true;
        v_next := CASE WHEN v_left[v_edge]=v_current THEN v_right[v_edge] ELSE v_left[v_edge] END;
        IF v_codes[v_edge]>0 THEN v_forward[v_codes[v_edge]] := v_left[v_edge]=v_current; END IF;
        v_current := v_next;
      END LOOP;
    END LOOP;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_raw) LOOP
      v_a := (v_row->>'a')::int; v_b := (v_row->>'b')::int; v_code := (v_row->>'code')::int;
      IF v_forward[v_code] = (v_seen[v_code] % 2 = 0) THEN v_home := v_members[v_a]; v_away := v_members[v_b];
      ELSE v_home := v_members[v_b]; v_away := v_members[v_a]; END IF;
      v_seen[v_code] := v_seen[v_code]+1;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('league_id',p_league_id,'league_season_id',p_season_id,'week_number',(v_row->>'week')::int,'matchup_type','regular_season','home_member_id',v_home,'away_member_id',v_away));
    END LOOP;
    SELECT older.id INTO v_previous FROM public.league_seasons older JOIN public.league_seasons current ON current.id=p_season_id
     WHERE older.league_id=p_league_id AND older.season_year<current.season_year ORDER BY older.season_year DESC LIMIT 1;
    IF v_previous IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('week_number',week_number,'matchup_type','regular_season','home_member_id',home_member_id,'away_member_id',away_member_id) ORDER BY week_number,home_member_id,away_member_id)
        INTO v_previous_rows FROM public.matchups WHERE league_season_id=v_previous AND matchup_type='regular_season' AND NOT is_voided;
      IF v_previous_rows IS NULL THEN
        SELECT jsonb_agg(value-'league_id'-'league_season_id' ORDER BY (value->>'week_number')::int,value->>'home_member_id',value->>'away_member_id') INTO v_previous_rows
          FROM jsonb_array_elements(private.regular_season_matchup_payload(p_league_id,v_previous,p_weeks));
      END IF;
      IF v_previous_rows=(SELECT jsonb_agg(value-'league_id'-'league_season_id' ORDER BY (value->>'week_number')::int,value->>'home_member_id',value->>'away_member_id') FROM jsonb_array_elements(v_rows)) THEN
        SELECT jsonb_agg(value || jsonb_build_object('home_member_id',value->>'away_member_id','away_member_id',value->>'home_member_id')) INTO v_rows FROM jsonb_array_elements(v_rows);
      END IF;
    END IF;
    RETURN v_rows;
  END IF;
  SELECT array_agg(id ORDER BY joined_at, id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
  v_count := COALESCE(cardinality(v_members), 0);
  IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
  IF v_count % 2 = 1 THEN
    v_members := array_append(v_members, NULL::uuid);
    v_count := v_count + 1;
  END IF;
  FOR v_week IN 1..p_weeks LOOP
    IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;
    v_round := v_played % (v_count - 1);
    v_played := v_played + 1;
    FOR v_pair IN 0..(v_count / 2 - 1) LOOP
      v_home := CASE WHEN v_pair = 0 THEN v_members[1] ELSE v_members[2 + (v_pair - 1 + v_round) % (v_count - 1)] END;
      v_away := v_members[2 + (v_count - 2 - v_pair + v_round) % (v_count - 1)];
      IF v_home IS NOT NULL AND v_away IS NOT NULL THEN
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'league_id', p_league_id, 'league_season_id', p_season_id,
          'week_number', v_week, 'matchup_type', 'regular_season',
          'home_member_id', v_home, 'away_member_id', v_away));
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_season_atomic(p_league_id uuid)
RETURNS TABLE(new_season_id uuid, new_year int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_new_season_id uuid;
  v_new_year int;
  v_far_year int;
  v_previous_flag text;
BEGIN
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status NOT IN ('playoffs'::league_status, 'archived'::league_status) THEN
    RAISE EXCEPTION 'League must be in playoffs or archived state before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found for this league';
  END IF;

  -- Prior+1 alone breaks a league that skipped a season or was created
  -- off-cycle: the derived year would never match season_weeks. The real
  -- calendar wins whenever it is ahead.
  v_new_year := GREATEST(
    v_current_season.season_year + 1,
    public.current_season_year_et(now())
  );
  v_far_year := v_new_year + 5;

  IF EXISTS (
    SELECT 1
      FROM league_seasons
     WHERE league_id = p_league_id
       AND season_year = v_new_year
  ) THEN
    RAISE EXCEPTION 'Season % already exists', v_new_year;
  END IF;

  v_previous_flag := private.begin_trade_lifecycle_write();
  UPDATE trades
     SET status = 'expired',
         completion_failure_reason = 'The season rolled over before this offer was accepted.'
   WHERE league_id = p_league_id
     AND league_season_id = v_current_season.id
     AND status = 'pending';
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current, rookie_draft_scheduled_at)
  VALUES (p_league_id, v_new_year, true, now() + interval '60 days')
  RETURNING id INTO v_new_season_id;

  PERFORM private.authorize_taxi_acquisition(p_league_id,v_new_season_id,member_id,player_id,'carry_over',v_current_season.id)
    FROM roster_players WHERE league_id=p_league_id AND league_season_id=v_current_season.id AND is_on_taxi;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
    'carry_over'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_current_season.id;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    'carry_over',
    acquired_at
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over';

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    CASE WHEN is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END,
    acquired_at + interval '1 millisecond'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over'
    AND (is_on_ir = true OR is_on_taxi = true);

  INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,occurred_at)
  SELECT current.league_id,current.league_season_id,current.member_id,current.player_id,'taxi_return',current.acquired_at+interval '1 millisecond'
  FROM roster_players current JOIN roster_players previous ON previous.league_season_id=v_current_season.id
    AND previous.member_id=current.member_id AND previous.player_id=current.player_id
  WHERE current.league_season_id=v_new_season_id AND previous.is_on_taxi AND NOT current.is_on_taxi;

  -- Fill skipped pick years and preserve existing owners.
  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    year_value,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
  CROSS JOIN generate_series(v_new_year,v_far_year) AS year_value
  CROSS JOIN unnest(ARRAY[1, 2, 3]) AS round_value
  WHERE lm.league_id = p_league_id
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  INSERT INTO waiver_priorities (
    league_id,
    league_season_id,
    member_id,
    priority
  )
  WITH latest_standings AS (
    SELECT DISTINCT ON (member_id)
      member_id,
      wins,
      losses,
      ties,
      points_for,
      points_against
    FROM standings
    WHERE league_id = p_league_id
      AND league_season_id = v_current_season.id
    ORDER BY member_id, week_number DESC
  ),
  ordered_members AS (
    SELECT
      lm.id AS member_id,
      row_number() OVER (
        ORDER BY
          (COALESCE(ls.wins, 0) + 0.5 * COALESCE(ls.ties, 0)) / GREATEST(COALESCE(ls.wins + ls.losses + ls.ties, 0), 1) ASC,
          COALESCE(ls.points_for, 0) / GREATEST(COALESCE(ls.wins + ls.losses + ls.ties, 0), 1) ASC,
          COALESCE(ls.losses, 0) DESC,
          COALESCE(ls.points_against, 0) DESC,
          lm.id ASC
      ) AS priority
    FROM league_members lm
    LEFT JOIN latest_standings ls ON ls.member_id = lm.id
    WHERE lm.league_id = p_league_id
  )
  SELECT p_league_id, v_new_season_id, member_id, priority
  FROM ordered_members;

  -- The trade deadline repeats every season.
  UPDATE leagues
     SET status = 'offseason',
         trade_deadline = private.trade_deadline_for_season(trade_deadline, v_new_year)
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_atomic(
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  title text,
  body text,
  data jsonb,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 200);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  WITH stale AS (
    SELECT queued.id FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= clock_timestamp()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND private.notif_is_stale(queued.event_type,queued.data)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = clock_timestamp(), suppression_reason = 'stale',
    claimed_at = NULL, claim_token = NULL FROM stale WHERE queued.id = stale.id;
  WITH disabled AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id = queued.member_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND NOT private.notif_preference_enabled(member.user_id,queued.event_type,queued.category)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = now(), suppression_reason = 'preferences_disabled',
    claimed_at = NULL, claim_token = NULL FROM disabled WHERE queued.id = disabled.id;
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
       AND queued.suppressed_at IS NULL
       AND NOT private.notif_is_stale(queued.event_type,queued.data)
       AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
       AND private.notif_preference_enabled((SELECT member.user_id FROM public.league_members member WHERE member.id = queued.member_id),queued.event_type,queued.category)
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.expo_ticket_id IS NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.created_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id, queued.title,
       queued.body, queued.data || jsonb_build_object('notificationEvent',queued.event_type,'outboxId',queued.id) AS data, queued.category
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id, claimed.title,
    claimed.body, claimed.data, claimed.category
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_notification_receipts_atomic(
  p_limit int DEFAULT 200,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  expo_ticket_id text,
  push_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 200), 0), 1000);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.suppressed_at IS NULL
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.expo_ticket_id IS NOT NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.ticketed_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id,
       queued.expo_ticket_id, queued.push_token
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id,
    claimed.expo_ticket_id, claimed.push_token
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET delivered_at = now(),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET dead_lettered_at = now(),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Permanent notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         available_at = now() + make_interval(
           secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)
         ),
         dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END,
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         receipt_attempt_count = 0,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_score_week_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_matchups jsonb,
  p_standings jsonb,
  p_finalized_at timestamptz DEFAULT now(),
  p_reconciliation_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_count int;
  v_distinct_count int;
  v_locked_count int;
  v_notifications jsonb := '[]'::jsonb;
  v_input_token jsonb;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF p_standings IS NULL OR jsonb_typeof(p_standings) <> 'array' THEN
    RAISE EXCEPTION 'p_standings must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT requested.id)
    INTO v_requested_count, v_distinct_count
    FROM jsonb_to_recordset(p_matchups) AS requested(
      id uuid,
      winner_member_id uuid,
      home_max_possible_points numeric,
      away_max_possible_points numeric
    );

  IF v_requested_count = 0 THEN
    RETURN v_notifications;
  END IF;

  IF v_distinct_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains duplicate matchup ids.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons WHERE id = p_league_season_id AND league_id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND p_week_number=ANY(skipped_weeks)) THEN RETURN '[]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));

  v_input_token := p_matchups->0->'input_token';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_matchups) item WHERE item->'input_token' IS DISTINCT FROM v_input_token)
      OR NOT private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token) THEN
    RAISE EXCEPTION 'Score inputs changed or were not certified. Retry scoring.' USING ERRCODE = 'PT409';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  )
  SELECT count(*)
    INTO v_locked_count
    FROM locked;

  IF v_locked_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains rows outside the target league season week.'
      USING ERRCODE = '22023';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  ),
  updated AS (
    UPDATE public.matchups AS matchup
       SET winner_member_id = locked.requested_winner_member_id,
           home_points = COALESCE(locked.requested_home_points, locked.home_points),
           away_points = COALESCE(locked.requested_away_points, locked.away_points),
           home_max_possible_points = locked.requested_home_max_possible_points,
           away_max_possible_points = locked.requested_away_max_possible_points,
           is_finalized = true,
           score_read_started_at = COALESCE(locked.requested_score_read_started_at, p_finalized_at),
           finalized_at = CASE
             WHEN locked.is_finalized IS FALSE THEN p_finalized_at
             WHEN locked.matchup_type IN (
               'playoff_quarterfinal'::matchup_type,
               'playoff_semifinal'::matchup_type,
               'playoff_final'::matchup_type
             ) AND (locked.winner_member_id IS DISTINCT FROM locked.requested_winner_member_id
               OR locked.home_max_possible_points IS DISTINCT FROM locked.requested_home_max_possible_points
               OR locked.away_max_possible_points IS DISTINCT FROM locked.requested_away_max_possible_points) THEN p_reconciliation_at
             ELSE matchup.finalized_at
           END
      FROM locked
     WHERE matchup.id = locked.id
       AND NOT private.playoff_matchup_is_consumed(locked.id)
       AND (locked.is_finalized IS DISTINCT FROM true
         OR (locked.winner_member_id, locked.home_points, locked.away_points,
             locked.home_max_possible_points, locked.away_max_possible_points)
           IS DISTINCT FROM
            (locked.requested_winner_member_id,
             COALESCE(locked.requested_home_points, locked.home_points),
             COALESCE(locked.requested_away_points, locked.away_points),
             locked.requested_home_max_possible_points, locked.requested_away_max_possible_points))
     RETURNING
       matchup.id,
       locked.is_finalized AS was_finalized,
       matchup.home_member_id,
       matchup.away_member_id,
       matchup.home_points,
       matchup.away_points,
       matchup.winner_member_id
  ),
  notification_rows AS (
    SELECT *
      FROM updated
     WHERE was_finalized IS FALSE
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'home_member_id', home_member_id,
        'away_member_id', away_member_id,
        'home_points', home_points,
        'away_points', away_points,
        'winner_member_id', winner_member_id
      )
      ORDER BY id
    ),
    '[]'::jsonb
  )
    INTO v_notifications
    FROM notification_rows;


  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT 'matchup:'||result.id||':final:'||recipient.member_id,
    recipient.member_id,'matchup_final',
    CASE WHEN COALESCE(matchup.end_week_number,p_week_number)=p_week_number
      THEN 'Week '||p_week_number ELSE 'Weeks '||p_week_number||'–'||matchup.end_week_number END||' Final',
    CASE WHEN result.winner_member_id IS NULL THEN 'You tied '
      WHEN result.winner_member_id=recipient.member_id THEN 'You won '
      ELSE 'You lost ' END
      ||round(COALESCE(recipient.points,0),2)::text||'–'||round(COALESCE(recipient.opponent_points,0),2)::text
      ||CASE WHEN result.winner_member_id=recipient.member_id THEN '! 🏆' ELSE '.' END,
    jsonb_build_object('type','matchup_final','leagueId',p_league_id,'leagueSeasonId',p_league_season_id,
      'matchupId',result.id,'weekNumber',p_week_number,'endWeekNumber',COALESCE(matchup.end_week_number,p_week_number)),
    'activity'
  FROM jsonb_to_recordset(v_notifications) result(id uuid,home_member_id uuid,away_member_id uuid,
    home_points numeric,away_points numeric,winner_member_id uuid)
  JOIN public.matchups matchup ON matchup.id=result.id
  CROSS JOIN LATERAL (VALUES(result.home_member_id,result.home_points,result.away_points),
    (result.away_member_id,result.away_points,result.home_points)) recipient(member_id,points,opponent_points)
  ON CONFLICT(dedupe_key) DO NOTHING;

  INSERT INTO public.standings (
    league_id,
    league_season_id,
    member_id,
    week_number,
    created_at,
    wins,
    losses,
    ties,
    points_for,
    points_against,
    max_possible_points,
    waiver_priority
  )
  SELECT
    p_league_id,
    p_league_season_id,
    standing.member_id,
    p_week_number,
    COALESCE(standing.created_at, p_finalized_at),
    standing.wins,
    standing.losses,
    standing.ties,
    standing.points_for,
    standing.points_against,
    standing.max_possible_points,
    standing.waiver_priority
  FROM jsonb_to_recordset(p_standings) AS standing(
    member_id uuid,
    created_at timestamptz,
    wins int,
    losses int,
    ties int,
    points_for numeric,
    points_against numeric,
    max_possible_points numeric,
    waiver_priority int
  )
  ON CONFLICT (league_id, league_season_id, member_id, week_number)
  DO UPDATE SET
    created_at = EXCLUDED.created_at,
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for,
    points_against = EXCLUDED.points_against,
    max_possible_points = EXCLUDED.max_possible_points
  WHERE (standings.wins, standings.losses, standings.ties,
         standings.points_for, standings.points_against, standings.max_possible_points)
    IS DISTINCT FROM
        (EXCLUDED.wins, EXCLUDED.losses, EXCLUDED.ties,
         EXCLUDED.points_for, EXCLUDED.points_against, EXCLUDED.max_possible_points);

  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND cardinality(skipped_weeks)>0) THEN
    PERFORM private.rebuild_regular_standings(p_league_id,p_league_season_id);
  END IF;

  INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
    VALUES(p_league_season_id, p_week_number, private.score_input_token(p_league_season_id, p_week_number))
    ON CONFLICT(league_season_id, week_number) DO UPDATE SET input_token = EXCLUDED.input_token
    WHERE score_week_certificates.input_token IS DISTINCT FROM EXCLUDED.input_token;

  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key = 779001 AND expires_at > clock_timestamp()) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_live_poll_work()) THEN
    PERFORM public.invoke_edge_function('live-poll');
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.edge_invocations
    WHERE function_name = 'sync-scores' AND queued_at > clock_timestamp() - interval '30 minutes') THEN
    RETURN;
  END IF;
  IF EXISTS (
    WITH candidates AS MATERIALIZED (
      SELECT season.id, matchup.week_number, week.week_end, bool_and(matchup.is_finalized) AS is_finalized
      FROM public.league_seasons season
      JOIN public.leagues league ON league.id = season.league_id
      JOIN public.matchups matchup ON matchup.league_season_id = season.id
      JOIN public.season_weeks week ON week.season_year = season.season_year
        AND week.week_number = COALESCE(matchup.end_week_number, matchup.week_number)
      WHERE season.is_current AND league.status IN ('active', 'playoffs') AND NOT matchup.is_voided
        AND (matchup.matchup_type = 'regular_season' OR NOT private.playoff_matchup_is_consumed(matchup.id))
        AND NOT EXISTS (SELECT 1 FROM public.matchups final
          WHERE final.league_season_id = season.id AND final.matchup_type = 'playoff_final'
            AND final.is_finalized AND NOT final.is_voided)
        AND NOT (matchup.week_number = ANY(season.skipped_weeks))
        AND NOT EXISTS (SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id = season.id)
        AND week.week_end <= (clock_timestamp() AT TIME ZONE 'America/New_York')::date
      GROUP BY season.id, matchup.week_number, week.week_end
    ), season_tokens AS MATERIALIZED (
      SELECT candidate.id,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM public.matchups stored WHERE stored.league_season_id = candidate.id
            AND stored.matchup_type <> 'regular_season'
        ) THEN private.score_input_token(candidate.id, max(candidate.week_number)) END AS input_token
      FROM candidates candidate GROUP BY candidate.id
    )
    SELECT 1 FROM candidates candidate
    JOIN season_tokens season_token ON season_token.id = candidate.id
    LEFT JOIN private.score_week_certificates certificate
      ON certificate.league_season_id = candidate.id AND certificate.week_number = candidate.week_number
    WHERE NOT candidate.is_finalized
      OR candidate.week_end >= (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 4
      OR certificate.input_token IS NULL
      OR certificate.input_token IS DISTINCT FROM CASE WHEN season_token.input_token IS NULL
        THEN private.score_input_token(candidate.id, candidate.week_number)
        ELSE (SELECT jsonb_object_agg(input.key, input.value) FROM jsonb_each(season_token.input_token) input
          WHERE CASE WHEN split_part(input.key, ':', 1) IN ('nba', 'lineup', 'result')
            THEN split_part(input.key, ':', 3)::int <= candidate.week_number ELSE true END)
      END
  ) THEN
    PERFORM public.invoke_edge_function('sync-scores');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_process_trades_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= now()
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= now()
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NOT NULL
      AND queued.available_at <= now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) THEN
    PERFORM public.invoke_edge_function('process-trades');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_season_boundary_if_due(
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Due from 09:00 ET onward, once per ET day; a tick delayed past the 9 o'clock
  -- hour used to skip the whole day's bracket/rollover work.
  IF v_now::time < make_time(9, 0, 0) THEN
    RETURN;
  END IF;

  -- Setup leagues have no bracket work, but one whose season ended before it
  -- drafted moves to the next season.
  PERFORM private.roll_setup_league_seasons(p_now);

  -- Drafting leagues can need the rookie-draft backstop.
  IF NOT EXISTS (
    SELECT 1
      FROM public.leagues
     WHERE status IN (
       'active'::public.league_status,
       'playoffs'::public.league_status,
       'offseason'::public.league_status,
       'drafting'::public.league_status
     )
  ) THEN
    RETURN;
  END IF;

  IF NOT private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('season-boundary', 'season-boundary');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_notification_outbox_ticket_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_expo_ticket_id text,
  p_push_token text,
  p_receipt_delay_seconds int DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delay int := LEAST(GREATEST(COALESCE(p_receipt_delay_seconds, 900), 0), 3600);
BEGIN
  IF p_expo_ticket_id IS NULL OR p_expo_ticket_id = '' OR octet_length(p_expo_ticket_id) > 200 OR
     p_push_token IS NULL OR p_push_token = '' OR octet_length(p_push_token) > 512 THEN
    RAISE EXCEPTION 'Invalid Expo ticket state.' USING ERRCODE = '22023';
  END IF;

  UPDATE notification_outbox
     SET expo_ticket_id = p_expo_ticket_id,
         push_token = p_push_token,
         ticketed_at = now(),
         receipt_attempt_count = 0,
         available_at = now() + make_interval(secs => v_delay),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL
     AND expo_ticket_id IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_regular_season_matchups_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_force boolean DEFAULT false,
  p_matchups jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_count int;
  v_start int;
  v_year int;
  v_league public.leagues%ROWTYPE;
  v_rounds int[];
  v_member_count int;
  v_inserted_count int := 0;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.';
  END IF;

  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  v_start := v_league.playoff_start_week;

  SELECT season.season_year INTO v_year
    FROM public.league_seasons AS season
   WHERE season.id = p_league_season_id
     AND season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for matchup generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(p_league_season_id::text));

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     WHERE requested.league_id IS DISTINCT FROM p_league_id
        OR requested.league_season_id IS DISTINCT FROM p_league_season_id
        OR requested.week_number IS NULL
        OR requested.week_number < 1
        OR requested.week_number >= v_start
        OR requested.matchup_type IS DISTINCT FROM 'regular_season'
        OR requested.home_member_id IS NULL
        OR requested.away_member_id IS NULL
        OR requested.home_member_id = requested.away_member_id
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.home_member_id
             AND member.league_id = p_league_id
        )
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.away_member_id
             AND member.league_id = p_league_id
        )
  ) THEN
    RAISE EXCEPTION 'p_matchups contains invalid regular-season rows.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     GROUP BY
        requested.league_id,
        requested.league_season_id,
        requested.week_number,
        requested.matchup_type,
        LEAST(requested.home_member_id::text, requested.away_member_id::text),
        GREATEST(requested.home_member_id::text, requested.away_member_id::text)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matchups contains duplicate weekly pairings.';
  END IF;

  SELECT count(*) INTO v_member_count FROM public.league_members WHERE league_id = p_league_id;
  IF jsonb_array_length(p_matchups) > 0 AND v_member_count >= 2 AND p_matchups IS DISTINCT FROM private.regular_season_matchup_payload(p_league_id,p_league_season_id,v_start-1) AND (
    (SELECT count(DISTINCT (value->>'week_number')::int) FROM jsonb_array_elements(p_matchups)) <> v_start - 1
    OR jsonb_array_length(p_matchups) <> (v_start - 1)::bigint * (v_member_count / 2)
  ) THEN
    RAISE EXCEPTION 'The proposed regular schedule does not match the saved playoff start. Reload settings and retry.';
  END IF;

  SELECT count(*)
    INTO v_existing_count
    FROM public.matchups
   WHERE league_season_id = p_league_season_id;

  IF v_existing_count > 0 THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  v_rounds := private.league_playoff_round_plan(v_league.id, v_member_count);
  PERFORM private.assert_playoff_window(v_year, v_start, v_rounds, true);

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(private.regular_season_matchup_payload(p_league_id,p_league_season_id,v_start-1)) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
  ),
  inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    SELECT
      requested.league_id,
      requested.league_season_id,
      requested.week_number,
      requested.matchup_type::public.matchup_type,
      requested.home_member_id,
      requested.away_member_id
    FROM requested
    WHERE NOT EXISTS (SELECT 1 FROM league_seasons WHERE id=p_league_season_id AND requested.week_number=ANY(skipped_weeks))
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*)
    INTO v_inserted_count
    FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 60,
  p_timer_expiry_behavior text DEFAULT 'auto_pick'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_order_count int;
  v_last_season_id uuid;
  v_pick_count int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  IF p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 60 OR p_pick_timer_seconds > 604800 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 60 and 604800.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_timer_expiry_behavior NOT IN ('auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick') THEN
    RAISE EXCEPTION 'Invalid rookie draft timeout behavior: %', v_timer_expiry_behavior
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status <> 'offseason' THEN
    RAISE EXCEPTION 'League must be in offseason to start rookie draft';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'snake'
       AND is_mock = false
       AND status IN ('pending', 'in_progress', 'paused')
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'A rookie draft already exists for this season';
    END IF;
  END IF;

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM draft_picks AS pick
     WHERE pick.league_id = p_league_id
       AND pick.season_year = v_season.season_year
       AND pick.is_used = false
       AND private.is_reserved_trade_asset(pick.league_id, NULL, pick.current_owner_id, NULL, pick.id)
  ) THEN
    RAISE EXCEPTION 'A pick in this draft class is reserved by an accepted trade. Complete or veto that trade before starting the rookie draft.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;

  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM private.league_playoff_round_plan(v_league.id, v_member_count);
  END IF;

  SELECT id
    INTO v_last_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = false
   ORDER BY season_year DESC
   LIMIT 1;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    started_at,
    is_mock,
    pick_timer_seconds,
    rounds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    'snake',
    'in_progress',
    now(),
    v_is_mock,
    p_pick_timer_seconds,
    p_rounds,
    v_timer_expiry_behavior
  )
  RETURNING * INTO v_draft;

  WITH ordered_members AS (
    SELECT
      lm.id AS member_id,
      CASE WHEN latest.member_id IS NULL THEN 0 ELSE 1 END AS has_standings,
      (COALESCE(latest.wins, 0) + 0.5 * COALESCE(latest.ties, 0)) / GREATEST(COALESCE(latest.wins + latest.losses + latest.ties, 0), 1) AS win_rate,
      COALESCE(latest.points_for, 0) / GREATEST(COALESCE(latest.wins + latest.losses + latest.ties, 0), 1) AS points_per_game
    FROM league_members AS lm
    LEFT JOIN LATERAL (
      SELECT s.member_id, s.wins, s.losses, s.ties, s.points_for
        FROM standings AS s
       WHERE v_last_season_id IS NOT NULL
         AND s.league_id = p_league_id
         AND s.league_season_id = v_last_season_id
         AND s.member_id = lm.id
       ORDER BY s.week_number DESC
       LIMIT 1
    ) AS latest ON true
    WHERE lm.league_id = p_league_id
  ),
  rookie_draft_order AS (
    SELECT
      member_id,
      row_number() OVER (
        ORDER BY
          has_standings DESC,
          win_rate ASC,
          points_per_game ASC,
          member_id ASC
      )::int AS position
    FROM ordered_members
  )
  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM rookie_draft_order
   ORDER BY position;

  GET DIAGNOSTICS v_order_count = ROW_COUNT;
  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;
  IF v_order_count <> v_member_count THEN
    RAISE EXCEPTION 'Failed to build a complete rookie draft order';
  END IF;

  IF v_is_mock THEN
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
    )
    INSERT INTO snake_draft_picks (
      draft_id,
      overall_pick,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    )
    SELECT
      v_draft.id,
      ((round - 1) * v_order_count) + pick_in_round,
      round,
      pick_in_round,
      member_id,
      NULL
    FROM pick_slots
    ORDER BY round, pick_in_round;
  ELSE
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id AS original_owner_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
    ),
    resolved AS (
      SELECT
        pick_slots.round,
        pick_slots.pick_in_round,
        pick_slots.original_owner_id,
        dp.id AS draft_pick_id,
        dp.current_owner_id AS member_id
      FROM pick_slots
      JOIN LATERAL (
        SELECT id, current_owner_id
          FROM draft_picks
         WHERE league_id = p_league_id
           AND season_year = v_season.season_year
           AND round = pick_slots.round
           AND original_owner_id = pick_slots.original_owner_id
           AND is_used = false
         ORDER BY id
         LIMIT 1
         FOR UPDATE
      ) AS dp ON true
    )
    INSERT INTO snake_draft_picks (
      draft_id,
      overall_pick,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    )
    SELECT
      v_draft.id,
      ((round - 1) * v_order_count) + pick_in_round,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    FROM resolved
    ORDER BY round, pick_in_round;
  END IF;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  PERFORM private.arm_next_snake_pick_timer(
    v_draft.id,
    clock_timestamp() + make_interval(secs => p_pick_timer_seconds)
  );

  IF NOT v_is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id
       AND status = 'offseason';

    GET DIAGNOSTICS v_pick_count = ROW_COUNT;
    IF v_pick_count <> 1 THEN
      RAISE EXCEPTION 'Failed to mark league as drafting';
    END IF;
  END IF;

  RETURN to_jsonb(v_draft);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_league_settings_atomic(
  p_league_id uuid,
  p_settings jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league public.leagues%ROWTYPE;
  v_user_id uuid := (SELECT auth.uid());
  v_touches_structural boolean;
  v_key text;
  v_skip int[];
  v_current public.league_seasons%ROWTYPE;
  v_scoring_settings jsonb;
  v_roster_size int;
  v_ir_slots int;
  v_taxi_slots int;
  v_auction_budget int;
  v_playoff_start_week int;
  v_playoff_total_weeks int;
  v_playoff_round_weeks int[];
  v_trade_deadline date;
  v_trade_deadline_set boolean := false;
  v_trade_deadline_text text;
  v_season_year int;
  v_weekly_add_limit int;
  v_weekly_add_unlimited boolean;
  v_waiver_mode text;
  v_faab_starting_budget int;
  v_trade_veto_mode text;
  v_trade_veto_window_hours int;
  v_trade_veto_threshold_percent int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change settings.'
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['team_limit','playoff_entrants','taxi_max_seasons'] LOOP
    IF p_settings ? v_key AND (jsonb_typeof(p_settings->v_key)<>'number' OR (p_settings->>v_key)!~'^[0-9]+$') THEN
      RAISE EXCEPTION '% must be a positive whole number.',v_key USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF p_settings ? 'team_limit' AND ((p_settings->>'team_limit')::int < 2 OR
      (p_settings->>'team_limit')::int < (SELECT count(*) FROM public.league_members WHERE league_id=p_league_id)) THEN
    RAISE EXCEPTION 'Team limit must be at least 2 and include every current team.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'playoff_entrants' AND (p_settings->>'playoff_entrants')::int < 2 THEN
    RAISE EXCEPTION 'Playoffs require at least 2 entrants.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'taxi_rule' AND (p_settings->>'taxi_rule') NOT IN ('drafted_rookies','rookies_or_64_games') THEN
    RAISE EXCEPTION 'Choose a valid taxi eligibility rule.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'taxi_max_seasons' AND (p_settings->>'taxi_max_seasons')::int NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Taxi tenure must be 1 or 2 seasons.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'allow_inactive_trades' AND jsonb_typeof(p_settings->'allow_inactive_trades')<>'boolean' THEN
    RAISE EXCEPTION 'Allow IR and taxi trades must be true or false.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'playoff_round_lengths' AND (jsonb_typeof(p_settings->'playoff_round_lengths')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings->'playoff_round_lengths') value
        WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[0-9]+$')) THEN
    RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'scoring_settings' AND jsonb_typeof(p_settings -> 'scoring_settings') = 'object' THEN
    v_scoring_settings := p_settings -> 'scoring_settings';
  END IF;

  IF p_settings ? 'roster_size' AND jsonb_typeof(p_settings -> 'roster_size') = 'number' THEN
    v_roster_size := (p_settings ->> 'roster_size')::int;
    IF v_roster_size <= 0 THEN
      RAISE EXCEPTION 'roster_size must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'ir_slots' AND jsonb_typeof(p_settings -> 'ir_slots') = 'number' THEN
    v_ir_slots := (p_settings ->> 'ir_slots')::int;
    IF v_ir_slots < 0 THEN
      RAISE EXCEPTION 'ir_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'taxi_slots' AND jsonb_typeof(p_settings -> 'taxi_slots') = 'number' THEN
    v_taxi_slots := (p_settings ->> 'taxi_slots')::int;
    IF v_taxi_slots < 0 THEN
      RAISE EXCEPTION 'taxi_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'auction_budget' AND jsonb_typeof(p_settings -> 'auction_budget') = 'number' THEN
    v_auction_budget := (p_settings ->> 'auction_budget')::int;
    IF v_auction_budget <= 0 THEN
      RAISE EXCEPTION 'auction_budget must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_start_week' THEN
    IF jsonb_typeof(p_settings -> 'playoff_start_week') <> 'number'
       OR (p_settings ->> 'playoff_start_week') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Playoff start week must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_start_week := (p_settings ->> 'playoff_start_week')::int;
    IF v_playoff_start_week <= 0 THEN
      RAISE EXCEPTION 'playoff_start_week must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_total_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_total_weeks') <> 'number'
       OR (p_settings ->> 'playoff_total_weeks') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_total_weeks := (p_settings ->> 'playoff_total_weeks')::int;
    IF v_playoff_total_weeks < 1 THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'playoff_round_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_round_weeks') <> 'array' THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') AS value
      WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value::text::int ORDER BY ordinality) INTO v_playoff_round_weeks
      FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') WITH ORDINALITY AS entry(value, ordinality);
    IF v_playoff_round_weeks IS NULL THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The deadline is a month and day ("MM-DD") that repeats every season; a
  -- full date keeps only its month and day. It is stored as the date inside
  -- the league's current season. JSON null removes it.
  IF p_settings ? 'trade_deadline' THEN
    v_trade_deadline_set := true;
    IF jsonb_typeof(p_settings -> 'trade_deadline') = 'string' THEN
      v_trade_deadline_text := trim(p_settings ->> 'trade_deadline');
      BEGIN
        IF v_trade_deadline_text ~ '^[0-9]{1,2}-[0-9]{1,2}$' THEN
          v_trade_deadline := make_date(
            2000,
            split_part(v_trade_deadline_text, '-', 1)::int,
            split_part(v_trade_deadline_text, '-', 2)::int
          );
        ELSE
          v_trade_deadline := v_trade_deadline_text::date;
        END IF;
      EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11.'
          USING ERRCODE = '22023';
      END;

      SELECT season.season_year
        INTO v_season_year
        FROM public.league_seasons AS season
       WHERE season.league_id = p_league_id
         AND season.is_current;
      v_trade_deadline := private.trade_deadline_for_season(
        v_trade_deadline,
        COALESCE(v_season_year, private.setup_season_year_et())
      );
    ELSIF jsonb_typeof(p_settings -> 'trade_deadline') <> 'null' THEN
      RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11, or null.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'weekly_add_unlimited' THEN
    IF jsonb_typeof(p_settings -> 'weekly_add_unlimited') <> 'boolean' THEN
      RAISE EXCEPTION 'weekly_add_unlimited must be a boolean.'
        USING ERRCODE = '22023';
    END IF;
    v_weekly_add_unlimited := (p_settings ->> 'weekly_add_unlimited')::boolean;
  END IF;

  IF p_settings ? 'weekly_add_limit' AND jsonb_typeof(p_settings -> 'weekly_add_limit') = 'number' THEN
    v_weekly_add_limit := (p_settings ->> 'weekly_add_limit')::int;
    IF v_weekly_add_limit < 1 THEN
      RAISE EXCEPTION 'weekly_add_limit must be at least 1, or use unlimited mode.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'waiver_mode' AND jsonb_typeof(p_settings -> 'waiver_mode') = 'string' THEN
    v_waiver_mode := p_settings ->> 'waiver_mode';
    IF v_waiver_mode NOT IN ('rolling', 'faab') THEN
      RAISE EXCEPTION 'waiver_mode must be rolling or faab.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'faab_starting_budget' AND jsonb_typeof(p_settings -> 'faab_starting_budget') = 'number' THEN
    v_faab_starting_budget := (p_settings ->> 'faab_starting_budget')::int;
    IF v_faab_starting_budget < 0 THEN
      RAISE EXCEPTION 'faab_starting_budget must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_mode' AND jsonb_typeof(p_settings -> 'trade_veto_mode') = 'string' THEN
    v_trade_veto_mode := p_settings ->> 'trade_veto_mode';
    IF v_trade_veto_mode NOT IN ('disabled', 'commissioner', 'member_vote') THEN
      RAISE EXCEPTION 'trade_veto_mode must be disabled, commissioner, or member_vote.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_window_hours' AND jsonb_typeof(p_settings -> 'trade_veto_window_hours') = 'number' THEN
    v_trade_veto_window_hours := (p_settings ->> 'trade_veto_window_hours')::int;
    IF v_trade_veto_window_hours < 0 OR v_trade_veto_window_hours > 168 THEN
      RAISE EXCEPTION 'trade_veto_window_hours must be between 0 and 168.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_threshold_percent' AND jsonb_typeof(p_settings -> 'trade_veto_threshold_percent') = 'number' THEN
    v_trade_veto_threshold_percent := (p_settings ->> 'trade_veto_threshold_percent')::int;
    IF v_trade_veto_threshold_percent < 1 OR v_trade_veto_threshold_percent > 100 THEN
      RAISE EXCEPTION 'trade_veto_threshold_percent must be between 1 and 100.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_touches_structural :=
       v_scoring_settings IS NOT NULL
    OR v_roster_size IS NOT NULL
    OR v_ir_slots IS NOT NULL
    OR v_taxi_slots IS NOT NULL
    OR v_auction_budget IS NOT NULL
    OR p_settings ? 'team_limit';

  IF v_touches_structural
     AND v_league.status IS DISTINCT FROM 'setup'::public.league_status
  THEN
    RAISE EXCEPTION
      'Structural league settings (scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget) can only be changed before the draft starts.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.leagues
     SET team_limit = CASE WHEN p_settings ? 'team_limit' THEN (p_settings->>'team_limit')::int ELSE team_limit END,
         taxi_rule = COALESCE(p_settings->>'taxi_rule',taxi_rule),
         taxi_max_seasons = CASE WHEN p_settings ? 'taxi_max_seasons' THEN (p_settings->>'taxi_max_seasons')::int ELSE taxi_max_seasons END,
         allow_inactive_trades = CASE WHEN p_settings ? 'allow_inactive_trades' THEN (p_settings->>'allow_inactive_trades')::boolean ELSE allow_inactive_trades END,
         playoff_entrants = CASE WHEN p_settings ? 'playoff_entrants' THEN (p_settings->>'playoff_entrants')::int ELSE playoff_entrants END,
         playoff_round_lengths = CASE WHEN p_settings ? 'playoff_round_lengths' THEN ARRAY(SELECT jsonb_array_elements_text(p_settings->'playoff_round_lengths'))::int[] ELSE playoff_round_lengths END,
         scoring_settings = CASE WHEN v_scoring_settings IS NULL THEN scoring_settings ELSE scoring_settings || v_scoring_settings END,
         roster_size = COALESCE(v_roster_size, roster_size),
         ir_slots = COALESCE(v_ir_slots, ir_slots),
         taxi_slots = COALESCE(v_taxi_slots, taxi_slots),
         auction_budget = COALESCE(v_auction_budget, auction_budget),
         playoff_start_week = COALESCE(v_playoff_start_week, playoff_start_week),
         playoff_total_weeks = COALESCE(v_playoff_total_weeks, playoff_total_weeks),
         playoff_round_weeks = COALESCE(v_playoff_round_weeks, playoff_round_weeks),
         trade_deadline = CASE WHEN v_trade_deadline_set THEN v_trade_deadline ELSE trade_deadline END,
         weekly_add_limit = CASE
           WHEN v_weekly_add_unlimited IS TRUE THEN NULL
           WHEN v_weekly_add_limit IS NOT NULL THEN v_weekly_add_limit
           ELSE weekly_add_limit
         END,
         waiver_mode = COALESCE(v_waiver_mode, waiver_mode),
         faab_starting_budget = COALESCE(v_faab_starting_budget, faab_starting_budget),
         trade_veto_mode = COALESCE(v_trade_veto_mode, trade_veto_mode),
         trade_veto_window_hours = COALESCE(v_trade_veto_window_hours, trade_veto_window_hours),
         trade_veto_threshold_percent = COALESCE(v_trade_veto_threshold_percent, trade_veto_threshold_percent)
   WHERE id = p_league_id;

  IF p_settings ? 'skipped_weeks' THEN
    IF jsonb_typeof(p_settings->'skipped_weeks')<>'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_settings->'skipped_weeks') value
        WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[0-9]+$') THEN
      RAISE EXCEPTION 'Skipped weeks must be positive whole week numbers.' USING ERRCODE='22023';
    END IF;
    SELECT ARRAY(SELECT DISTINCT value::int FROM jsonb_array_elements_text(p_settings->'skipped_weeks') value ORDER BY value::int) INTO v_skip;
    SELECT * INTO v_current FROM public.league_seasons WHERE league_id=p_league_id AND is_current FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'),hashtext(v_current.id::text));
    PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'),hashtext(v_current.id::text));
    IF NOT v_current.skipped_weeks <@ v_skip THEN
      RAISE EXCEPTION 'Skipped weeks cannot be restored. Contact the commissioner before skipping a week.';
    END IF;
    IF v_skip IS DISTINCT FROM v_current.skipped_weeks THEN
      IF EXISTS (SELECT 1 FROM unnest(v_skip) week WHERE week<1 OR week>=COALESCE(v_playoff_start_week,v_league.playoff_start_week)
        OR NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year=v_current.season_year AND week_number=week)) THEN
        RAISE EXCEPTION 'Only calendar weeks before playoffs can be skipped.' USING ERRCODE='22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id=v_current.id AND matchup_type<>'regular_season') THEN
        RAISE EXCEPTION 'Weeks cannot be voided after playoff seeds are frozen.';
      END IF;
      UPDATE public.league_seasons SET skipped_weeks=v_skip WHERE id=v_current.id;
      UPDATE public.matchups SET is_voided=true WHERE league_season_id=v_current.id AND week_number=ANY(v_skip);
      IF EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id=v_current.id AND NOT is_voided)
        AND NOT EXISTS (
          SELECT 1 FROM public.matchups m
          LEFT JOIN public.season_weeks w ON w.season_year=v_current.season_year AND w.week_number=m.week_number
          WHERE m.league_season_id=v_current.id AND (
            w.id IS NULL OR w.week_start<=(now() AT TIME ZONE 'America/New_York')::date
            OR m.is_finalized OR m.winner_member_id IS NOT NULL
            OR COALESCE(m.home_points,0)<>0 OR COALESCE(m.away_points,0)<>0)) THEN
        DELETE FROM public.matchups WHERE league_season_id=v_current.id AND matchup_type='regular_season' AND NOT is_voided;
        INSERT INTO public.matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id)
          SELECT p_league_id,v_current.id,r.week_number,'regular_season',r.home_member_id,r.away_member_id
          FROM jsonb_to_recordset(private.regular_season_matchup_payload(
            p_league_id,v_current.id,COALESCE(v_playoff_start_week,v_league.playoff_start_week)-1))
          AS r(week_number int,home_member_id uuid,away_member_id uuid);
      END IF;
      PERFORM private.rebuild_regular_standings(p_league_id,v_current.id);
    END IF;
  END IF;

  IF v_faab_starting_budget IS NOT NULL THEN
    UPDATE public.faab_balances AS balance
       SET balance = v_faab_starting_budget,
           updated_at = now()
      FROM public.league_seasons AS season
     WHERE balance.league_id = p_league_id
       AND balance.league_season_id = season.id
       AND season.is_current = true
       AND balance.balance = v_league.faab_starting_budget;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_preference_enabled(p_user_id uuid, p_event text, p_category text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  p public.notification_preferences%ROWTYPE;
  e public.notif_event_catalog%ROWTYPE;
  v_legacy text;
BEGIN
  SELECT * INTO p FROM public.notification_preferences WHERE user_id = p_user_id;
  IF p.master_enabled IS FALSE THEN RETURN false; END IF;
  SELECT * INTO e FROM public.notif_event_catalog WHERE event_type = p_event;
  v_legacy := COALESCE(e.legacy_column, CASE p_category
    WHEN 'trade' THEN 'trade_enabled' WHEN 'draft' THEN 'draft_enabled'
    WHEN 'waiver' THEN 'waiver_enabled' ELSE 'activity_enabled' END);
  IF (to_jsonb(p)->>v_legacy)::boolean IS FALSE THEN RETURN false; END IF;
  IF (p.category_settings->>COALESCE(e.category,p_category))::boolean IS FALSE THEN RETURN false; END IF;
  RETURN COALESCE((p.event_settings->>p_event)::boolean,e.default_enabled,
    p_event IN ('rookie_draft_pick','waiver_claim_succeeded','waiver_claim_failed'));
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_begin_web_atomic(p_id uuid, p_claim_token uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.notification_outbox%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.claim_token IS DISTINCT FROM p_claim_token OR r.delivered_at IS NOT NULL
    OR r.suppressed_at IS NOT NULL OR r.dead_lettered_at IS NOT NULL THEN RETURN 'lost'; END IF;
  IF r.web_delivered_at IS NOT NULL THEN RETURN 'delivered'; END IF;
  IF r.web_attempted_at IS NOT NULL AND (r.web_failed_at IS NULL OR r.web_failed_at < r.web_attempted_at) THEN RETURN 'attempted'; END IF;
  UPDATE public.notification_outbox SET web_attempted_at = clock_timestamp(), web_failed_at = NULL, web_attempt_claim_token = p_claim_token WHERE id = p_id;
  RETURN 'send';
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_finish_web_atomic(p_id uuid, p_claim_token uuid, p_sent boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.notification_outbox SET web_delivered_at = CASE WHEN p_sent THEN clock_timestamp() ELSE web_delivered_at END,
    web_failed_at = CASE WHEN NOT p_sent THEN clock_timestamp() ELSE web_failed_at END
  WHERE id = p_id AND (web_attempt_claim_token = p_claim_token OR claim_token = p_claim_token) AND web_attempted_at IS NOT NULL;
  RETURN FOUND;
END;
$$;
