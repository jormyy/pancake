DROP TRIGGER IF EXISTS compact_inventory_insert ON public.league_activity;
DROP TRIGGER IF EXISTS compact_inventory_update ON public.league_activity;
DROP TRIGGER IF EXISTS compact_inventory_delete ON public.league_activity;

CREATE OR REPLACE FUNCTION private.emit_league_inventory_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_details text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'draft_picks' THEN
      v_details := $details$SELECT pick.league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object(
          'resource','picks','season_id',season.id,'member_id',pick.current_owner_id) END AS detail
        FROM changed pick LEFT JOIN public.league_seasons season
          ON season.league_id=pick.league_id AND season.season_year=pick.season_year$details$;
    WHEN 'waiver_claims' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','claims','season_id',league_season_id) AS detail FROM changed WHERE status NOT IN ('pending','cancelled')$details$;
    WHEN 'waiver_wire_log' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','waivers','season_id',league_season_id) AS detail FROM changed$details$;
    WHEN 'waiver_priorities' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','priority','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'faab_balances' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','faab','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'league_seasons' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','season','season_id',id) AS detail FROM changed$details$;
    ELSE
      v_details := 'SELECT league_id,NULL::jsonb AS detail FROM changed';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),details AS (%s),distinct_details AS (
      SELECT DISTINCT details.league_id,details.detail FROM details
      JOIN public.leagues league ON league.id=details.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 AND bool_and(detail IS NOT NULL)
        THEN jsonb_agg(detail ORDER BY detail::text) END AS details
      FROM distinct_details GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_details) LOOP
    PERFORM private.publish_league_inventory_hint(v_change.league_id,v_change.details);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid, p_only_member_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_count record;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  SELECT * INTO v_league FROM leagues WHERE id = v_trade.league_id FOR UPDATE;
  IF NOT v_league.allow_inactive_trades THEN RETURN; END IF;
  PERFORM 1 FROM players player
    WHERE player.id IN (SELECT player_id FROM trade_items WHERE trade_id=p_trade_id)
    ORDER BY player.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=item.from_member_id AND player_id=item.player_id)) THEN
    RAISE EXCEPTION 'A trade player is no longer owned by the expected team.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id = item.player_id
    WHERE item.trade_id = p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_ir AND
      (item.to_taxi OR NOT private.is_ir_designation(player.injury_status))) THEN
    RAISE EXCEPTION 'Incoming IR players must be Out or IR-designated and cannot also enter taxi.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
      ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
    WHERE item.trade_id = p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi
      AND NOT private.taxi_player_eligible(v_trade.league_id, item.player_id)) THEN
    RAISE EXCEPTION 'Incoming taxi players must be rookies or have fewer than 65 career regular-season games.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
    ON roster.league_season_id=v_trade.league_season_id AND roster.player_id=item.player_id
    JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi AND v_league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(v_trade.league_id,roster.player_id,season.season_year)>=v_league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'Incoming taxi player has reached the taxi tenure limit.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN league_member_taxi_exits exit
    ON exit.league_id=v_trade.league_id AND exit.member_id=item.to_member_id AND exit.player_id=item.player_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi) THEN
    RAISE EXCEPTION 'A promoted player cannot return to this team taxi squad.' USING ERRCODE='PT001';
  END IF;
  FOR v_team IN SELECT participant.*, member.team_name FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id = p_only_member_id)
    ORDER BY participant.member_id LOOP
    IF EXISTS (SELECT 1 FROM unnest(v_team.drop_player_ids) drop_choice(player_id) WHERE
      NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id = v_trade.league_season_id
        AND roster.member_id = v_team.member_id AND roster.player_id = drop_choice.player_id)
      OR EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id AND item.player_id = drop_choice.player_id)
      OR private.is_reserved_trade_asset(v_trade.league_id, v_trade.league_season_id, v_team.member_id, drop_choice.player_id, NULL, p_trade_id)
      OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND status='pending' AND drop_player_id=drop_choice.player_id)) THEN
      RAISE EXCEPTION 'A selected trade drop is missing, reserved, or included in the offer.' USING ERRCODE = 'PT001';
    END IF;
    SELECT count(*) AS total, count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
      count(*) FILTER (WHERE on_ir) AS ir, count(*) FILTER (WHERE on_taxi) AS taxi INTO v_count
    FROM (
      SELECT roster.is_on_ir AS on_ir, roster.is_on_taxi AS on_taxi FROM roster_players roster
      WHERE roster.league_season_id = v_trade.league_season_id AND roster.member_id = v_team.member_id
        AND NOT roster.player_id = ANY(v_team.drop_player_ids)
        AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id
          AND item.from_member_id = v_team.member_id AND item.player_id = roster.player_id)
      UNION ALL
      SELECT item.to_ir, item.to_taxi OR roster.is_on_taxi FROM trade_items item
      JOIN roster_players roster ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
      WHERE item.trade_id = p_trade_id AND item.to_member_id = v_team.member_id
    ) resulting;
    IF v_count.total > v_league.roster_size + v_league.ir_slots + v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the total roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.active > v_league.roster_size THEN
      RAISE EXCEPTION '% must change its trade plan to meet the active roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.ir > v_league.ir_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the IR limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.taxi > v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the taxi limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_roster_player_with_lineup_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text,
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_slot_type roster_slot_type DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_activate_player_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF (p_free_roster_player_id IS NULL AND p_free_action IS NOT NULL)
     OR (p_free_roster_player_id IS NOT NULL AND p_free_action IS NULL) THEN
    RAISE EXCEPTION 'Overflow player and overflow action must be provided together.'
      USING ERRCODE = '22023';
  END IF;

  IF p_free_roster_player_id IS NOT NULL
     AND p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  IF p_slot_type = 'IR'::roster_slot_type THEN
    RAISE EXCEPTION 'Use roster IR actions instead of lineup IR assignment.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_roster_activation(
    p_activate_roster_player_id, p_activate_source, p_free_roster_player_id
  );

  IF NOT EXISTS (
    SELECT 1 FROM roster_players WHERE id = p_activate_roster_player_id
      AND member_id = p_member_id AND league_id = p_league_id AND league_season_id = p_league_season_id
  ) THEN
    RAISE EXCEPTION 'Activated player is not on this roster.' USING ERRCODE = 'P0002';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
    CASE p_free_action
      WHEN 'drop' THEN
        PERFORM public.drop_player_atomic(p_free_roster_player_id);
      WHEN 'ir' THEN
        PERFORM private.toggle_ir_for_activation(p_free_roster_player_id, true, v_user_id,
          CASE WHEN p_activate_source='ir' THEN p_activate_roster_player_id END);
      ELSE
        RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
          USING ERRCODE = '22023';
    END CASE;
  END IF;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;

  IF p_slot_type IS NOT NULL AND p_slot_type <> 'BE'::roster_slot_type THEN
    SELECT player_id
      INTO v_activate_player_id
      FROM public.roster_players
     WHERE id = p_activate_roster_player_id
       AND member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id;

    IF v_activate_player_id IS NULL THEN
      RAISE EXCEPTION 'Activated player is not on this roster.'
        USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.set_player_slot_atomic(
      p_member_id,
      p_league_id,
      p_league_season_id,
      v_activate_player_id,
      p_game_date,
      p_slot_type,
      p_week_number
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_roster_player_with_overflow_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_roster_activation(
    p_activate_roster_player_id, p_activate_source, p_free_roster_player_id
  );

  CASE p_free_action
    WHEN 'drop' THEN
      PERFORM public.drop_player_atomic(p_free_roster_player_id);
    WHEN 'ir' THEN
      PERFORM private.toggle_ir_for_activation(p_free_roster_player_id, true, v_user_id,
          CASE WHEN p_activate_source='ir' THEN p_activate_roster_player_id END);
    ELSE
      RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
        USING ERRCODE = '22023';
  END CASE;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;
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
  WITH deleted AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NOT NULL
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL AND queued.suppressed_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at=clock_timestamp(),suppression_reason='league_deleted',
    claimed_at=NULL,claim_token=NULL FROM deleted WHERE queued.id=deleted.id;
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
       AND EXISTS (SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
         WHERE member.id=queued.member_id AND league.deleted_at IS NULL)
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

CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
  v_lock_player_id uuid;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.league_season_id::text));

  -- Use the roster writers' lock order before any claim or league row lock.
  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(p_member_id::text));
  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id, p_drop_player_id]) AS players(player_id)
     WHERE player_id IS NOT NULL
     ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;


  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.' USING ERRCODE = '42501';
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

  -- Like create_waiver_claim_atomic, edits require eligible league/season state
  -- and add capacity. An uncleared waiver entry stays editable until processing,
  -- even after clears_at; a processed entry no longer accepts edits.
  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active, playoff, or offseason league.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_claim.league_season_id
     AND is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, p_member_id);

  PERFORM 1
    FROM waiver_wire_log
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
     AND player_id = v_claim.player_id
     AND cleared_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on waivers.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL AND p_drop_player_id = v_claim.player_id THEN
    RAISE EXCEPTION 'You cannot drop the player you are claiming.'
      USING ERRCODE = '22023';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.available_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE waiver_claims
     SET to_ir = COALESCE(p_to_ir, to_ir),
         drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_playoff_start_week int;
  v_member_count int;
  v_playoff_size int;
  v_rounds int[];
  v_league public.leagues%ROWTYPE;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
  v_seed int;
  v_size int;
  v_type public.matchup_type;
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, COALESCE(playoff_start_week, v_league.playoff_start_week, 20)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type <> 'regular_season'
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = false AND NOT matchup.is_voided
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Regular season matchups must be finalized before generating playoffs.';
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = true
   FOR UPDATE;

  SELECT count(*)
    INTO v_member_count
    FROM public.league_members AS member
   WHERE member.league_id = p_league_id;

  IF v_member_count < COALESCE(v_league.playoff_entrants,4) THEN
    RAISE EXCEPTION 'Not enough teams to seed playoffs (need %).',COALESCE(v_league.playoff_entrants,4);
  END IF;

  v_playoff_size := COALESCE(v_league.playoff_entrants,CASE WHEN v_member_count >= 10 THEN 6 ELSE 4 END);

  v_rounds := private.league_playoff_round_plan(v_league.id, v_member_count);
  PERFORM private.assert_playoff_window(v_season_year, v_playoff_start_week, v_rounds, v_league.playoff_entrants IS NOT NULL);
  UPDATE public.league_seasons
     SET playoff_start_week = v_playoff_start_week, playoff_round_weeks = v_rounds
   WHERE id = v_season_id;

  SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
    INTO v_seed_ids
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS seed;

  UPDATE public.league_seasons
     SET playoff_seed_member_ids = CASE WHEN v_playoff_size IN (4,6) THEN v_seed_ids[1:v_playoff_size] END,
         playoff_bracket_seed_ids = CASE WHEN v_league.playoff_entrants IS NOT NULL THEN v_seed_ids[1:v_playoff_size] END
   WHERE id = v_season_id;

  IF v_league.playoff_entrants IS NOT NULL THEN
    RETURN private.generate_playoff_round(p_league_id,v_season_id,1);
  END IF;

  v_size := power(2,cardinality(v_rounds))::int;
  v_type := CASE cardinality(v_rounds) WHEN 3 THEN 'playoff_quarterfinal'::public.matchup_type
    WHEN 2 THEN 'playoff_semifinal'::public.matchup_type ELSE 'playoff_final'::public.matchup_type END;
  FOR v_seed IN 1..(v_size/2) LOOP
    IF v_size+1-v_seed <= v_playoff_size THEN
      INSERT INTO public.matchups(league_id,league_season_id,week_number,end_week_number,matchup_type,home_member_id,away_member_id)
      VALUES(p_league_id,v_season_id,v_playoff_start_week,v_playoff_start_week+v_rounds[1]-1,v_type,
        v_seed_ids[v_seed],v_seed_ids[v_size+1-v_seed])
      ON CONFLICT (league_id,league_season_id,week_number,home_member_id,away_member_id) DO NOTHING;
      v_inserted_count := v_inserted_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('inserted',v_inserted_count,'skipped',false);
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
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
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
    WHERE queued.suppressed_at IS NULL
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NOT NULL
      AND queued.available_at <= now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) THEN
    PERFORM public.invoke_edge_function('process-trades');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_playoff_start_week_change_after_bracket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season public.league_seasons%ROWTYPE;
  v_rounds int[];
  v_members int;
  v_had_schedule boolean;
  v_had_bracket boolean;
BEGIN
  -- The league UPDATE already holds the first lock. Every schedule writer
  -- takes league, season, advisory locks, then matchup rows in that order.
  SELECT * INTO v_season FROM public.league_seasons
   WHERE league_id = NEW.id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found. Playoff settings were not changed.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(v_season.id::text));
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season.id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = v_season.id FOR UPDATE;
  v_had_schedule := FOUND;
  SELECT EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id = v_season.id AND matchup_type <> 'regular_season') INTO v_had_bracket;
  PERFORM private.assert_schedule_not_started(v_season.id);
  SELECT count(*) INTO v_members FROM public.league_members WHERE league_id = NEW.id;
  v_rounds := private.league_playoff_round_plan(NEW.id, v_members);
  PERFORM private.assert_playoff_window(v_season.season_year, NEW.playoff_start_week, v_rounds, true);
  UPDATE public.league_seasons
     SET playoff_start_week = NEW.playoff_start_week, playoff_round_weeks = NULL, playoff_seed_member_ids = NULL, playoff_bracket_seed_ids = NULL
   WHERE id = v_season.id;
  IF v_had_schedule THEN
    DELETE FROM public.matchups WHERE league_season_id = v_season.id;
    -- A changed future schedule gets fresh standings tie evidence at seeding.
    PERFORM public.replace_regular_season_matchups_atomic(NEW.id, v_season.id, false,
      private.regular_season_matchup_payload(NEW.id, v_season.id, NEW.playoff_start_week - 1));
    IF v_had_bracket AND NEW.playoff_start_week = 1 THEN
      PERFORM public.generate_playoff_bracket_atomic(NEW.id);
    ELSIF v_had_bracket AND NEW.status = 'playoffs' THEN
      UPDATE public.leagues SET status = 'active' WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
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

  IF p_force THEN
    BEGIN
      PERFORM private.assert_schedule_not_started(p_league_season_id);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION 'The season has started; the schedule can no longer be rebuilt.' USING ERRCODE='P0001';
    END;
    DELETE FROM public.matchups WHERE league_season_id=p_league_season_id AND matchup_type='regular_season';
  ELSIF v_existing_count > 0 THEN
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

CREATE OR REPLACE FUNCTION public.reset_draft_atomic(
  p_draft_id uuid,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_player_ids uuid[];
  v_current_season_id uuid;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- Match season advancement's lock order before inspecting mutable context.
  PERFORM 1 FROM leagues WHERE id = v_draft.league_id FOR UPDATE;
  SELECT id INTO v_current_season_id
    FROM league_seasons
   WHERE league_id = v_draft.league_id AND is_current = true
   FOR UPDATE;
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF NOT v_draft.is_mock AND v_draft.league_season_id IS DISTINCT FROM v_current_season_id THEN
    RAISE EXCEPTION 'Only current season drafts can be reset.';
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1 FROM trades
     WHERE league_id = v_draft.league_id AND status = 'accepted'::trade_status
  ) THEN
    RAISE EXCEPTION 'Resolve accepted trades before resetting the draft.';
  END IF;

  IF v_draft.status NOT IN ('pending', 'in_progress', 'paused', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Draft cannot be reset from status %.', v_draft.status;
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1 FROM (
      SELECT player_id, member_id FROM snake_draft_picks WHERE draft_id=p_draft_id AND player_id IS NOT NULL
      UNION ALL
      SELECT player_id, winning_member_id FROM nominations WHERE draft_id=p_draft_id AND status='sold'
    ) drafted
    WHERE NOT EXISTS (SELECT 1 FROM roster_players roster
      WHERE roster.league_season_id=v_draft.league_season_id AND roster.player_id=drafted.player_id
        AND roster.member_id=drafted.member_id AND roster.acquired_via='draft')
  ) THEN
    RAISE EXCEPTION 'Players from this draft changed teams. Reverse those moves before resetting the draft.';
  END IF;

  IF v_draft.draft_type = 'auction' THEN
    v_player_ids := ARRAY(
      SELECT player_id
        FROM nominations
       WHERE draft_id = p_draft_id
         AND status = 'sold'
         AND player_id IS NOT NULL
    );

    IF NOT v_draft.is_mock THEN
      -- Undoing the draft is not the team moving players out of taxi, so no taxi exit is recorded.
      INSERT INTO private.taxi_acquisition_context(transaction_id,league_id,league_season_id,member_id,player_id,source,related_id)
      SELECT pg_current_xact_id(), league_id, league_season_id, member_id, player_id, 'draft_reset', p_draft_id
        FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids)
         AND is_on_taxi
      ON CONFLICT (transaction_id,league_id,league_season_id,member_id,player_id)
        DO UPDATE SET source = EXCLUDED.source, related_id = EXCLUDED.related_id;

      DELETE FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids);

      DELETE FROM private.taxi_acquisition_context
       WHERE transaction_id = pg_current_xact_id() AND source = 'draft_reset' AND related_id = p_draft_id;

      DELETE FROM roster_transactions
       WHERE league_season_id = v_draft.league_season_id
         AND related_nomination_id IN (
           SELECT id FROM nominations WHERE draft_id = p_draft_id
         );
    END IF;

    DELETE FROM bids
     WHERE nomination_id IN (SELECT id FROM nominations WHERE draft_id = p_draft_id);
    DELETE FROM nominations WHERE draft_id = p_draft_id;

    UPDATE draft_budgets
       SET remaining = initial_budget
     WHERE draft_id = p_draft_id;

  ELSE
    v_player_ids := ARRAY(
      SELECT player_id
        FROM snake_draft_picks
       WHERE draft_id = p_draft_id
         AND player_id IS NOT NULL
    );

    IF NOT v_draft.is_mock THEN
      -- Undoing the draft is not the team moving players out of taxi, so no taxi exit is recorded.
      INSERT INTO private.taxi_acquisition_context(transaction_id,league_id,league_season_id,member_id,player_id,source,related_id)
      SELECT pg_current_xact_id(), league_id, league_season_id, member_id, player_id, 'draft_reset', p_draft_id
        FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids)
         AND is_on_taxi
      ON CONFLICT (transaction_id,league_id,league_season_id,member_id,player_id)
        DO UPDATE SET source = EXCLUDED.source, related_id = EXCLUDED.related_id;

      DELETE FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids);

      DELETE FROM private.taxi_acquisition_context
       WHERE transaction_id = pg_current_xact_id() AND source = 'draft_reset' AND related_id = p_draft_id;

      DELETE FROM roster_transactions
       WHERE league_season_id = v_draft.league_season_id
         AND transaction_type = 'draft_won'
         AND player_id = ANY(v_player_ids);

      UPDATE draft_picks
         SET is_used = false,
             used_at = NULL,
             rookie_draft_id = NULL
       WHERE rookie_draft_id = p_draft_id;
    END IF;

    UPDATE snake_draft_picks
       SET player_id = NULL,
           picked_at = NULL,
           skipped_at = NULL,
           skip_reason = NULL,
           timer_expires_at = NULL
     WHERE draft_id = p_draft_id;

    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      clock_timestamp() + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         current_nomination_order = 1,
         completed_at = NULL,
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  IF NOT v_draft.is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = v_draft.league_id;
  END IF;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'reset',
    jsonb_build_object(
      'previousStatus', v_draft.status,
      'draftType', v_draft.draft_type,
      'isMock', v_draft.is_mock,
      'playersRemoved', COALESCE(array_length(v_player_ids, 1), 0)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.toggle_ir_for_activation(p_roster_player_id,p_to_ir,p_user_id,NULL);
END;
$$;

CREATE OR REPLACE FUNCTION private.toggle_ir_for_activation(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid, p_activate_roster_player_id uuid)
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
  v_rookie_draft_id uuid;
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

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status = 'completed'
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
     AND NOT (v_league.status = 'offseason'::league_status AND p_to_ir = false) THEN
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

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_rp.is_on_ir = p_to_ir THEN RETURN; END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  IF p_to_ir THEN
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id
       AND (p_activate_roster_player_id IS NULL OR id <> p_activate_roster_player_id);

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
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;

DROP TABLE public.rps_challenges;

REVOKE ALL ON FUNCTION private.toggle_ir_for_activation(uuid,boolean,uuid,uuid) FROM PUBLIC,anon,authenticated;
