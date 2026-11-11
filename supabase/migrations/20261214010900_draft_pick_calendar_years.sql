BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.trade_estimate_history,public.trade_estimate_quotes IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS guard_trade_pick_years ON public.trade_estimate_quotes;
DROP TRIGGER IF EXISTS guard_trade_pick_years ON public.trade_estimate_history;

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
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.create_league', jsonb_build_array(p_name, p_team_name, p_auction_budget), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_user_id      uuid := (SELECT auth.uid());
  v_team_name    text := regexp_replace(p_team_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_slug         text;
  v_invite_code  text;
  v_league_id    uuid;
  v_member_id    uuid;
  v_season_id    uuid;
  v_season_year  int;
  v_future_pick_years smallint;
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_team_name IS NULL OR v_team_name = '' OR char_length(v_team_name) > 40 THEN
    RAISE EXCEPTION 'Team name must contain 1 to 40 characters.';
  END IF;

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    SELECT lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]', '', 'g'))
      INTO v_email_prefix
      FROM auth.users
     WHERE id = v_user_id;

    v_email_prefix := COALESCE(NULLIF(v_email_prefix, ''), 'user');
    IF length(v_email_prefix) < 3 THEN v_email_prefix := 'user'; END IF;
    v_username := v_email_prefix;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
      v_counter := v_counter + 1;
      v_username := v_email_prefix || v_counter::text;
      IF v_counter > 999 THEN EXIT; END IF;
    END LOOP;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES (v_user_id, v_username, v_email_prefix)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  v_season_year := private.setup_season_year_et();
  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := public.generate_invite_code();

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget, playoff_start_week)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget, 17)
  RETURNING id, future_pick_years INTO v_league_id, v_future_pick_years;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', v_team_name)
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_season_id, v_member_id, 1);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, year_value, round_value, v_member_id, v_member_id
    FROM generate_series(v_season_year, v_season_year + v_future_pick_years - 1) AS year_value
   CROSS JOIN generate_series(1, 3) AS round_value;

  __request_result := jsonb_build_object(
    'id',              v_league_id,
    'name',            trim(p_name),
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'setup'
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_league_by_invite_code(p_invite_code text, p_team_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.join_league_by_invite_code', jsonb_build_array(p_invite_code, p_team_name), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_league           public.leagues%ROWTYPE;
  v_user_id          uuid := (SELECT auth.uid());
  v_team_name        text := regexp_replace(p_team_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_invite_code      text := upper(trim(coalesce(p_invite_code, '')));
  v_existing         uuid;
  v_member_id        uuid;
  v_member_count     int;
  v_league_season_id uuid;
  v_season_year      int;
  v_priority         int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_team_name IS NULL OR v_team_name = '' OR char_length(v_team_name) > 40 THEN
    RAISE EXCEPTION 'Team name must contain 1 to 40 characters.';
  END IF;

  IF v_invite_code !~ '^[A-Z0-9]{16}$' THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = v_invite_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'This league is no longer accepting new members.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  PERFORM v_existing;

  SELECT count(*)
  INTO   v_member_count
  FROM   public.league_members
  WHERE  league_id = v_league.id;

  IF v_member_count >= v_league.team_limit THEN
    RAISE EXCEPTION 'This league is full.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, season_year
  INTO   v_league_season_id, v_season_year
  FROM   public.league_seasons
  WHERE  league_id = v_league.id
    AND  is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League has no active season.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', v_team_name)
  RETURNING id INTO v_member_id;

  SELECT COALESCE(max(wp.priority), 0) + 1
  INTO   v_priority
  FROM   public.waiver_priorities AS wp
  WHERE  wp.league_id = v_league.id
    AND  wp.league_season_id = v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league.id, v_league_season_id, v_member_id, v_priority);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league.id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year, v_season_year + v_league.future_pick_years - 1) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  __request_result := jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$function$;

CREATE OR REPLACE FUNCTION private.reconcile_future_picks(p_league_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year int;
  v_years smallint;
  v_reference record;
  v_predicate text := '';
BEGIN
  SELECT league.future_pick_years,season.season_year INTO v_years,v_year
  FROM public.leagues league JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
  WHERE league.id=p_league_id FOR UPDATE OF league;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT p_league_id,year_value,round_value,member.id,member.id
  FROM public.league_members member
  CROSS JOIN generate_series(v_year,v_year+v_years-1) year_value
  CROSS JOIN generate_series(1,3) round_value
  WHERE member.league_id=p_league_id
  ON CONFLICT(league_id,season_year,round,original_owner_id) DO NOTHING;

  PERFORM 1 FROM public.draft_picks pick
  WHERE pick.league_id=p_league_id AND pick.season_year>v_year+v_years-1
    AND pick.current_owner_id=pick.original_owner_id AND NOT pick.is_used
    AND pick.used_at IS NULL AND pick.rookie_draft_id IS NULL
  ORDER BY pick.id FOR UPDATE;
  FOR v_reference IN
    SELECT constraint_row.conrelid::regclass AS relation,
      string_agg(format('referenced.%I = pick.%I',child.attname,parent.attname),' AND ' ORDER BY keys.ordinality) AS condition
    FROM pg_catalog.pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey,constraint_row.confkey) WITH ORDINALITY AS keys(child_number,parent_number,ordinality)
    JOIN pg_catalog.pg_attribute child ON child.attrelid=constraint_row.conrelid AND child.attnum=keys.child_number
    JOIN pg_catalog.pg_attribute parent ON parent.attrelid=constraint_row.confrelid AND parent.attnum=keys.parent_number
    WHERE constraint_row.contype='f' AND constraint_row.confrelid='public.draft_picks'::regclass
    GROUP BY constraint_row.oid,constraint_row.conrelid ORDER BY constraint_row.conrelid,constraint_row.oid
  LOOP
    v_predicate := v_predicate || format(' AND NOT EXISTS (SELECT 1 FROM %s AS referenced WHERE %s)',v_reference.relation,v_reference.condition);
  END LOOP;
  EXECUTE 'DELETE FROM public.draft_picks pick WHERE pick.league_id=$1 AND pick.season_year>$2
    AND pick.current_owner_id=pick.original_owner_id AND NOT pick.is_used AND pick.used_at IS NULL AND pick.rookie_draft_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.league_activity activity WHERE activity.league_id=pick.league_id
      AND activity.metadata->>''pick_id''=pick.id::text)' || v_predicate
    USING p_league_id,v_year+v_years-1;
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

  v_new_year := GREATEST(
    v_current_season.season_year + 1,
    public.current_season_year_et(now())
  );
  v_far_year := v_new_year + v_league.future_pick_years - 1;

  UPDATE draft_picks SET is_used=true,used_at=now()
    WHERE league_id=p_league_id AND season_year<v_new_year-1 AND NOT is_used;

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
  CROSS JOIN generate_series(v_new_year-1,v_far_year) AS year_value
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

  UPDATE leagues
     SET status = 'offseason',
         trade_deadline = private.trade_deadline_for_season(trade_deadline, v_new_year)
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
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
       AND pick.season_year = v_season.season_year - 1
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
    timer_expiry_behavior,
    rookie_draft_order
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
    v_timer_expiry_behavior,
    v_league.rookie_draft_order
  )
  RETURNING * INTO v_draft;

  v_order_count := public.generate_linear_draft_order(v_draft.id);
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
          WHEN v_draft.rookie_draft_order = 'snake' AND rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
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
          WHEN v_draft.rookie_draft_order = 'snake' AND rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
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
           AND season_year = v_season.season_year - 1
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
    UPDATE draft_picks SET is_used=true,used_at=now()
      WHERE league_id=p_league_id AND season_year=v_season.season_year-1 AND round>p_rounds AND NOT is_used;
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

CREATE OR REPLACE FUNCTION public.reseed_rookie_draft_picks_atomic(
  p_draft_id uuid,
  p_rounds int DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_rounds int;
  v_season_year int;
  v_order_count int;
  v_pick_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  v_rounds := COALESCE(p_rounds, v_draft.rounds, 3);
  IF v_rounds < 1 OR v_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;

  PERFORM 1
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NOT NULL
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot reseed - picks have already been made';
  END IF;

  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = v_draft.league_season_id
   FOR SHARE;

  SELECT count(*)
    INTO v_order_count
    FROM draft_orders
   WHERE draft_id = p_draft_id;

  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Draft orders not found';
  END IF;

  DELETE FROM snake_draft_picks
   WHERE draft_id = p_draft_id;

  WITH pick_slots AS (
    SELECT
      rounds.round,
      ordered.member_id AS original_owner_id,
      CASE
        WHEN v_draft.rookie_draft_order = 'snake' AND rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
        ELSE ordered.position
      END AS pick_in_round
    FROM generate_series(1, v_rounds) AS rounds(round)
    CROSS JOIN draft_orders AS ordered
    WHERE ordered.draft_id = p_draft_id
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
       WHERE league_id = v_draft.league_id
         AND season_year = v_season_year - 1
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
    p_draft_id,
    ((round - 1) * v_order_count) + pick_in_round,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  FROM resolved
  ORDER BY round, pick_in_round;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * v_rounds THEN
    RAISE EXCEPTION 'Failed to reseed every rookie draft pick slot';
  END IF;

  RETURN v_pick_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_picks(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; picks jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pick.id, 'seasonYear', pick.season_year, 'round', pick.round,
    'isUsed', pick.is_used, 'originalOwnerMemberId', pick.original_owner_id, 'originalTeamName', COALESCE(original.team_name, 'Unknown'),
    'currentOwnerMemberId', pick.current_owner_id, 'currentTeamName', COALESCE(owner.team_name, 'Unknown')) ORDER BY pick.season_year, pick.round, pick.id), '[]')
  INTO picks FROM public.draft_picks pick LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.league_members owner ON owner.id = pick.current_owner_id
  WHERE pick.league_id = p_league_id AND NOT pick.is_used
    AND pick.season_year BETWEEN (context->'season'->>'season_year')::int - 1
      AND (context->'season'->>'season_year')::int + (context->'league'->>'future_pick_years')::int - 1
    AND (p_params->>'targetMemberId' IS NULL OR pick.current_owner_id = (p_params->>'targetMemberId')::uuid);
  RETURN jsonb_build_object('context', context, 'picks', picks);
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_window(p_league_id uuid, p_pick_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_status public.league_status; v_future_pick_years smallint;
BEGIN
  SELECT status, future_pick_years INTO v_status, v_future_pick_years FROM public.leagues WHERE id=p_league_id FOR NO KEY UPDATE NOWAIT;
  IF v_status='setup' OR EXISTS (
    SELECT 1 FROM public.drafts draft
    JOIN public.league_seasons season ON season.id=draft.league_season_id AND season.is_current
    WHERE draft.league_id=p_league_id AND NOT draft.is_mock AND draft.draft_type='auction'
      AND draft.status IN ('pending','in_progress','paused')
  ) THEN
    RAISE EXCEPTION 'Trades open after the startup draft.' USING ERRCODE='P0001';
  END IF;
  IF v_status NOT IN ('offseason','drafting','active','playoffs') THEN
    RAISE EXCEPTION 'Trades open during offseason, drafting, active, and playoff seasons.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_picks pick JOIN public.league_seasons season
      ON season.league_id=pick.league_id AND season.is_current
    WHERE pick.league_id=p_league_id AND pick.id=ANY(p_pick_ids) AND pick.season_year<season.season_year-1
  ) THEN
    RAISE EXCEPTION 'Picks from past seasons cannot be traded.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_picks pick JOIN public.league_seasons season
      ON season.league_id=pick.league_id AND season.is_current
    WHERE pick.league_id=p_league_id AND pick.id=ANY(p_pick_ids) AND pick.season_year>season.season_year+v_future_pick_years-1
  ) THEN
    RAISE EXCEPTION 'Only the next % future draft years can be traded.',v_future_pick_years USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.drafts draft
    JOIN public.league_seasons season ON season.id=draft.league_season_id AND season.is_current
    JOIN public.snake_draft_picks slot ON slot.draft_id=draft.id
    WHERE draft.league_id=p_league_id AND NOT draft.is_mock
      AND draft.status IN ('in_progress','paused')
      AND slot.draft_pick_id=ANY(p_pick_ids) AND slot.player_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Picks in the live draft can be traded after the draft.' USING ERRCODE='P0001';
  END IF;
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
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.update_league_settings_atomic', jsonb_build_array(p_league_id, p_settings), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
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
  v_future_pick_years int;
  v_required_pick_years int;
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

  IF p_settings ? 'future_pick_years' THEN
    IF jsonb_typeof(p_settings->'future_pick_years') <> 'number'
      OR (p_settings->>'future_pick_years') !~ '^[0-9]+$'
      OR (p_settings->>'future_pick_years')::numeric NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION 'Future draft years must be a whole number between 1 and 10.' USING ERRCODE='22023';
    END IF;
    v_future_pick_years := (p_settings->>'future_pick_years')::int;
    IF v_future_pick_years < v_league.future_pick_years THEN
      SELECT max(pick.season_year-season.season_year+1) INTO v_required_pick_years
      FROM public.draft_picks pick JOIN public.league_seasons season ON season.league_id=pick.league_id AND season.is_current
      WHERE pick.league_id=p_league_id AND (
        pick.current_owner_id<>pick.original_owner_id
        OR EXISTS (SELECT 1 FROM public.trade_items item WHERE item.pick_id=pick.id));
      IF v_future_pick_years < v_required_pick_years THEN
        RAISE EXCEPTION 'Future draft years cannot be lower than % because a pick in that year has been traded or included in a trade.',v_required_pick_years USING ERRCODE='22023';
      END IF;
    END IF;
  END IF;

  IF p_settings ? 'timezone' AND (jsonb_typeof(p_settings->'timezone')<>'string' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=p_settings->>'timezone')) THEN
    RAISE EXCEPTION 'Choose a valid IANA timezone.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'rookie_draft_order' AND (jsonb_typeof(p_settings->'rookie_draft_order')<>'string' OR p_settings->>'rookie_draft_order' NOT IN ('linear','snake')) THEN
    RAISE EXCEPTION 'Rookie draft order must be linear or snake.' USING ERRCODE='22023';
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
     SET future_pick_years = COALESCE(v_future_pick_years, future_pick_years),
         timezone = CASE WHEN p_settings ? 'timezone' THEN p_settings->>'timezone' ELSE timezone END,
         rookie_draft_order = CASE WHEN p_settings ? 'rookie_draft_order' THEN p_settings->>'rookie_draft_order' ELSE rookie_draft_order END,
         team_limit = CASE WHEN p_settings ? 'team_limit' THEN (p_settings->>'team_limit')::int ELSE team_limit END,
         taxi_rule = 'rookies_or_64_games',
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

  IF v_future_pick_years IS NOT NULL AND v_future_pick_years <> v_league.future_pick_years THEN
    PERFORM private.reconcile_future_picks(p_league_id);
  END IF;

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
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION private.build_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb,p_require_ownership boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE; terms jsonb;
  v_item jsonb; seen text[]:='{}'; identity text; player_ids uuid[]; replacement_ids uuid[];
  player_rows jsonb; replacement_rows jsonb; player_input_rows jsonb; picks jsonb; balances jsonb; pick_values jsonb:='[]'::jsonb;
  rosters jsonb; best_free_agent numeric;
  previous_user text:=current_setting('request.jwt.claim.sub',true); teams integer;
BEGIN
  SELECT l.* INTO league FROM public.leagues l JOIN public.league_members m ON m.league_id=l.id
    WHERE m.id=p_member_id AND m.user_id=p_user_id AND l.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized to estimate trades for this team.' USING ERRCODE='42501'; END IF;
  SELECT * INTO season FROM public.league_seasons WHERE league_id=league.id AND is_current;
  IF NOT FOUND THEN RAISE EXCEPTION 'This league has no active season.' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'A trade estimate needs between 1 and 100 assets.' USING ERRCODE='22023';
  END IF;
  terms:=private.canonical_trade_estimate_terms(p_items);
  FOR v_item IN SELECT value FROM jsonb_array_elements(terms) LOOP
    IF v_item->>'fromMemberId' IS NULL OR v_item->>'toMemberId' IS NULL OR v_item->>'fromMemberId'=v_item->>'toMemberId'
      OR (v_item->>'playerId' IS NOT NULL)::int+(v_item->>'pickId' IS NOT NULL)::int+((v_item->>'faabAmount')::int>0)::int<>1
      OR (v_item->>'faabAmount')::int<0 THEN
      RAISE EXCEPTION 'Each estimate asset must move between two different teams.' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM public.league_members WHERE league_id=league.id
      AND id IN((v_item->>'fromMemberId')::uuid,(v_item->>'toMemberId')::uuid))<>2 THEN
      RAISE EXCEPTION 'All trade participants must belong to this league.' USING ERRCODE='42501';
    END IF;
    identity:=CASE WHEN v_item->>'playerId' IS NOT NULL THEN 'player:'||(v_item->>'playerId')
      WHEN v_item->>'pickId' IS NOT NULL THEN 'pick:'||(v_item->>'pickId')
      ELSE 'faab:'||(v_item->>'fromMemberId')||':'||(v_item->>'toMemberId') END;
    IF identity=ANY(seen) THEN RAISE EXCEPTION 'Each trade asset must appear exactly once.' USING ERRCODE='22023'; END IF;
    seen:=array_append(seen,identity);
    IF p_require_ownership AND v_item->>'playerId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.roster_players r
      WHERE r.league_id=league.id AND r.league_season_id=season.id AND r.member_id=(v_item->>'fromMemberId')::uuid
        AND r.player_id=(v_item->>'playerId')::uuid) THEN
      RAISE EXCEPTION 'A selected player is no longer owned by the sending team.' USING ERRCODE='22023';
    END IF;
    IF p_require_ownership AND v_item->>'pickId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.draft_picks p
      WHERE p.league_id=league.id AND p.current_owner_id=(v_item->>'fromMemberId')::uuid
        AND p.id=(v_item->>'pickId')::uuid AND NOT p.is_used) THEN
      RAISE EXCEPTION 'A selected pick is no longer available to the sending team.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=league.id;
  SELECT COALESCE(array_agg((item->>'playerId')::uuid ORDER BY item->>'playerId'),'{}') INTO player_ids
    FROM jsonb_array_elements(terms) item WHERE item->>'playerId' IS NOT NULL;
  SELECT COALESCE(array_agg(candidate.player_id),'{}') INTO replacement_ids FROM (
    SELECT average.player_id FROM (
      SELECT player_id,league_id,season_year,avg_fantasy_points FROM public.player_season_averages
        WHERE league_id=league.id AND season_year=season.season_year AND EXISTS(
          SELECT 1 FROM private.screen_refresh_queue WHERE league_season_id=season.id AND averages_initialized)
      UNION ALL
      SELECT player_id,league.id,season.season_year,avg_fantasy_points
        FROM private.trade_value_fantasy_averages(league.id,season.season_year) WHERE NOT EXISTS(
          SELECT 1 FROM private.screen_refresh_queue WHERE league_season_id=season.id AND averages_initialized)
    ) average
    JOIN public.players player ON player.id=average.player_id AND player.nba_team IS NOT NULL
    WHERE average.league_id=league.id AND average.season_year=season.season_year
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_id=league.id
        AND roster.league_season_id=season.id AND roster.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ) candidate;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  IF cardinality(player_ids||replacement_ids)>0 THEN
    player_input_rows:=private.trade_value_player_inputs(league.id,p_member_id,season.season_year,
      ARRAY(SELECT DISTINCT id FROM unnest(player_ids||replacement_ids) id ORDER BY id),105);
  ELSE
    player_input_rows:='[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(player ORDER BY player->>'player_id'),'[]'::jsonb) INTO player_rows
    FROM jsonb_array_elements(player_input_rows) player WHERE (player->>'player_id')::uuid=ANY(player_ids);
  SELECT COALESCE(jsonb_agg(player ORDER BY player->>'player_id'),'[]'::jsonb) INTO replacement_rows
    FROM jsonb_array_elements(player_input_rows) player WHERE (player->>'player_id')::uuid=ANY(replacement_ids);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(terms) item WHERE item->>'pickId' IS NOT NULL) THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(value)),'[]'::jsonb) INTO pick_values FROM public.get_dynasty_pick_values(league.id) value;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,
    'slot',slot.pick_in_round,
    'valueBands',COALESCE((SELECT jsonb_object_agg(value.tier,CASE WHEN value.tier='mid' AND slot.pick_in_round IS NULL THEN COALESCE(pick.predicted_trade_value,value.trade_value) ELSE value.trade_value END) FROM jsonb_to_recordset(pick_values) AS value(draft_year integer,round integer,tier text,trade_value numeric,fetched_at timestamptz)
      WHERE value.draft_year=pick.season_year AND value.round=pick.round),CASE WHEN slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN jsonb_set(pick.predicted_value_bands,'{mid}',to_jsonb(pick.predicted_trade_value)) ELSE pick.predicted_value_bands END),
    'valueFetchedAt',(SELECT max(value.fetched_at) FROM jsonb_to_recordset(pick_values) AS value(draft_year integer,round integer,tier text,trade_value numeric,fetched_at timestamptz)
      WHERE value.draft_year=pick.season_year AND value.round=pick.round)) ORDER BY pick.id),'[]'::jsonb) INTO picks
  FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
  LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
  WHERE pick.id IN(SELECT (item->>'pickId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT jsonb_agg(jsonb_build_object('memberId',member.id,'balance',COALESCE(balance.balance,league.faab_starting_budget)) ORDER BY member.id)
    INTO balances FROM public.league_members member LEFT JOIN public.faab_balances balance
    ON balance.member_id=member.id AND balance.league_season_id=season.id WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId',member.id,
    'limits',jsonb_build_object('active',league.roster_size,'ir',league.ir_slots,'taxi',league.taxi_slots),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('playerId',roster.player_id,'location',
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END,
      'tradeValue',(SELECT ranking.trade_value FROM public.dynasty_rankings ranking
        WHERE ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)) ORDER BY roster.player_id)
      FROM public.roster_players roster WHERE roster.league_season_id=season.id AND roster.member_id=member.id),'[]'::jsonb))
    ORDER BY member.id),'[]'::jsonb) INTO rosters FROM public.league_members member WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item
      UNION SELECT (item->>'toMemberId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT COALESCE(max(candidate.trade_value),0) INTO best_free_agent FROM (
    SELECT DISTINCT ON (ranking.player_id) ranking.player_id,ranking.trade_value
    FROM public.dynasty_rankings ranking JOIN public.players player ON player.id=ranking.player_id
    WHERE ranking.source='onenumberhoops.com' AND player.nba_team IS NOT NULL
      AND NOT ranking.player_id=ANY(player_ids)
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id
        AND roster.player_id=ranking.player_id)
    ORDER BY ranking.player_id,ranking.fetched_at DESC,ranking.source_rank,ranking.id
  ) candidate WHERE candidate.trade_value BETWEEN 0 AND 1000;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  RETURN jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,
    'teams',teams,'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'rosters',rosters,'bestFreeAgentValue',best_free_agent,'terms',terms,'players',player_rows,'replacementPlayers',replacement_rows,'picks',picks,'balances',balances);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_inputs(p_trade_id uuid,p_run text DEFAULT 'onenumber-trade-curve-v6')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  trade public.trades%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  terms jsonb; player_ids uuid[]; replacement_ids uuid[]; players jsonb; replacements jsonb; picks jsonb;
  rosters jsonb; best_free_agent numeric;
  actor uuid; teams integer; floor_value numeric; inputs jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  IF EXISTS(SELECT 1 FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version=p_run) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT league FROM public.leagues WHERE id=trade.league_id;
  SELECT * INTO STRICT season FROM public.league_seasons WHERE id=trade.league_season_id;
  SELECT user_id INTO actor FROM public.league_members WHERE id=trade.proposer_member_id;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=league.id;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=trade.id;
  SELECT COALESCE(array_agg((item->>'playerId')::uuid),'{}') INTO player_ids
    FROM jsonb_array_elements(terms) item WHERE item->>'playerId' IS NOT NULL;
  SELECT COALESCE(array_agg(candidate.player_id),'{}') INTO replacement_ids FROM (
    SELECT average.player_id FROM private.trade_value_fantasy_averages(league.id,season.season_year) average
    JOIN public.players player ON player.id=average.player_id AND player.nba_team IS NOT NULL
    WHERE NOT EXISTS(SELECT 1 FROM public.roster_players r WHERE r.league_id=league.id AND r.league_season_id=season.id AND r.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ) candidate;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  players:=private.trade_value_player_inputs(league.id,trade.proposer_member_id,season.season_year,player_ids,100);
  replacements:=private.trade_value_player_inputs(league.id,trade.proposer_member_id,season.season_year,replacement_ids,5);
  SELECT LEAST(500,COALESCE(avg(r.trade_value),GREATEST(50,180.0*200/GREATEST(1,teams*league.roster_size)))) INTO floor_value
    FROM public.dynasty_rankings r WHERE r.source='onenumberhoops.com' AND r.player_id=ANY(replacement_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,'slot',slot.pick_in_round,
    'valueBands',COALESCE((SELECT jsonb_object_agg(v.tier,CASE WHEN v.tier='mid' AND slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN pick.predicted_trade_value WHEN v.round=3 THEN GREATEST(v.trade_value,floor_value) ELSE v.trade_value END)
      FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year AND v.round=pick.round),CASE WHEN slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN jsonb_set(pick.predicted_value_bands,'{mid}',to_jsonb(pick.predicted_trade_value)) ELSE pick.predicted_value_bands END),
    'valueFetchedAt',(SELECT max(v.fetched_at) FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year AND v.round=pick.round)) ORDER BY pick.id),'[]'::jsonb)
    INTO picks FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    WHERE pick.id IN(SELECT (item->>'pickId')::uuid FROM jsonb_array_elements(terms) item WHERE item->>'pickId' IS NOT NULL);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId',member.id,
    'limits',jsonb_build_object('active',league.roster_size,'ir',league.ir_slots,'taxi',league.taxi_slots),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('playerId',roster.player_id,'location',
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END,
      'tradeValue',(SELECT ranking.trade_value FROM public.dynasty_rankings ranking
        WHERE ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)) ORDER BY roster.player_id)
      FROM (
        SELECT roster.player_id,roster.is_on_ir,roster.is_on_taxi,CASE WHEN trade.status='completed' AND item.player_id IS NOT NULL
          THEN item.from_member_id ELSE roster.member_id END AS member_id
        FROM public.roster_players roster LEFT JOIN public.trade_items item ON item.trade_id=trade.id AND item.player_id=roster.player_id
        WHERE roster.league_season_id=season.id
        UNION ALL SELECT item.player_id,false,false,item.from_member_id FROM public.trade_items item
        WHERE item.trade_id=trade.id AND item.player_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id AND roster.player_id=item.player_id)
      ) roster WHERE roster.member_id=member.id),'[]'::jsonb))
    ORDER BY member.id),'[]'::jsonb) INTO rosters FROM public.league_members member WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item
      UNION SELECT (item->>'toMemberId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT COALESCE(max(candidate.trade_value),0) INTO best_free_agent FROM (
    SELECT DISTINCT ON (ranking.player_id) ranking.player_id,ranking.trade_value
    FROM public.dynasty_rankings ranking JOIN public.players player ON player.id=ranking.player_id
    WHERE ranking.source='onenumberhoops.com' AND player.nba_team IS NOT NULL
      AND NOT ranking.player_id=ANY(player_ids)
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id
        AND roster.player_id=ranking.player_id)
    ORDER BY ranking.player_id,ranking.fetched_at DESC,ranking.source_rank,ranking.id
  ) candidate WHERE candidate.trade_value BETWEEN 0 AND 1000;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  inputs:=jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,'teams',teams,
    'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'rosters',rosters,'bestFreeAgentValue',best_free_agent,'terms',terms,'players',players,'replacementPlayers',replacements,'picks',picks,'revaluationTradeId',trade.id);
  inputs:=inputs||jsonb_build_object('playerDestinations',(
    SELECT COALESCE(jsonb_object_agg(item.player_id::text,CASE WHEN item.to_taxi THEN 'taxi' WHEN item.to_ir THEN 'ir' ELSE
      CASE WHEN EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id
        AND roster.player_id=item.player_id AND roster.is_on_taxi) THEN 'taxi' ELSE 'active' END END),'{}'::jsonb)
    FROM public.trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL));
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now());
END;
$$;

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
      AND (trade.status IN ('accepted','completed') OR trade.proposer_member_id IN(SELECT id FROM own_members)
        OR trade.recipient_member_id IN(SELECT id FROM own_members)
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

CREATE OR REPLACE FUNCTION public.view_trade_details(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; trade public.trades%ROWTYPE; participants jsonb; items jsonb; estimate jsonb; unavailable text; result jsonb; analysis_context jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO trade FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'trade', NULL, 'analysis', NULL); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', participant.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'sortOrder', participant.sort_order, 'isInitiator', participant.is_initiator, 'acceptedAt', participant.accepted_at,
    'dropPlayerIds', participant.drop_player_ids, 'rosterMoves', participant.roster_moves)
    ORDER BY participant.sort_order, member.team_name, participant.member_id), '[]')
  INTO participants FROM public.trade_participants participant LEFT JOIN public.league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = trade.id;
  SELECT COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'tradeValue', (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'tradeValue', COALESCE(pick.predicted_trade_value,(SELECT value.trade_value FROM public.get_dynasty_pick_values(p_league_id) value
        WHERE value.draft_year=pick.season_year AND value.round=pick.round AND value.tier=CASE
          WHEN slot.pick_in_round IS NULL THEN 'mid'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,(SELECT count(*) FROM public.league_members WHERE league_id=p_league_id))/3.0) THEN 'early'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,(SELECT count(*) FROM public.league_members WHERE league_id=p_league_id))*2/3.0) THEN 'mid'
          ELSE 'late' END)),
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
  INTO items FROM public.trade_items item LEFT JOIN public.players player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = public.current_season_year_et()
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = public.current_season_year_et()
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = public.current_season_year_et()
    WHERE item.trade_id = trade.id;
  SELECT CASE WHEN quote.id IS NOT NULL OR cached.trade_id IS NOT NULL THEN jsonb_build_object('quoteId', quote.id,
    'modelVersion',COALESCE(cached.revaluation->>'modelVersion',quote.model_version),
    'inputVersion',COALESCE(cached.revaluation->>'inputVersion',quote.input_version),
    'createdAt',COALESCE(cached.revaluation->>'createdAt',quote.created_at::text),
    'teams',COALESCE(cached.revaluation->'analysis'->'teams',quote.analysis->'teams'),
    'assets',COALESCE(cached.revaluation->'analysis'->'assets',quote.analysis->'assets')) END,
    recorded.unavailable_reason INTO estimate, unavailable FROM public.trade_estimates recorded
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id = recorded.quote_id
    LEFT JOIN public.trade_value_cache cached ON cached.trade_id=trade.id AND cached.revaluation->>'modelVersion'='onenumber-trade-curve-v6'
    WHERE recorded.trade_id = trade.id;
  result := jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', participants, 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', items, 'estimate', estimate, 'estimateUnavailable', unavailable);
  IF COALESCE((p_params->>'cardOnly')::boolean, false) THEN
    RETURN jsonb_build_object('trade', result);
  END IF;
  analysis_context := public.view_context(p_league_id, p_member_id, jsonb_build_object('seasonId', trade.league_season_id,'tradeId',trade.id));
  RETURN jsonb_build_object('context', context, 'trade', result,
    'roster', public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId')->'roster',
    'savedQuote', (SELECT jsonb_build_object('id', q.id, 'analysis', q.analysis, 'modelVersion', q.model_version, 'inputVersion', q.input_version, 'createdAt', q.created_at, 'expiresAt', q.expires_at, 'seasonYear', q.inputs->'seasonYear') FROM public.trade_estimates e JOIN public.trade_estimate_quotes q ON q.id = e.quote_id WHERE e.trade_id = trade.id),
    'rosterPreview', CASE WHEN COALESCE((p_params->>'includeRosterPreview')::boolean, true)
      THEN public.view_trade_preview(p_league_id, p_member_id, p_params) END,
    'analysis', (SELECT revaluation FROM public.trade_value_cache WHERE trade_id = trade.id),
    'analysisStale', COALESCE((analysis_context->>'tradeAnalysisStale')::boolean,true));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pick_prediction_inputs(p_league_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE season public.league_seasons%ROWTYPE; team_count integer; result jsonb;
BEGIN
  SELECT * INTO season FROM public.league_seasons WHERE league_id=p_league_id ORDER BY is_current DESC,season_year DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO team_count FROM public.league_members WHERE league_id=p_league_id;
  WITH bands AS MATERIALIZED (
    SELECT * FROM public.get_dynasty_pick_values(p_league_id)
  )
  SELECT jsonb_build_object('leagueId',p_league_id,'seasonYear',season.season_year,
    'sourceVersion',(SELECT content_sha256 FROM private.trade_value_sync_state WHERE id),
    'seasonGames',(SELECT NULLIF(count(*)*2.0/GREATEST(1,team_count),0) FROM public.matchups
      WHERE league_season_id=season.id AND matchup_type='regular_season' AND NOT is_voided),
    'teams',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',member.id,'wins',COALESCE(record.wins,0),'ties',COALESCE(record.ties,0),
      'players',(SELECT COALESCE(jsonb_agg(jsonb_build_object('value',COALESCE(ranking.trade_value,0),'age',ranking.age)),'[]'::jsonb)
        FROM public.roster_players roster LEFT JOIN public.dynasty_rankings ranking
          ON ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        WHERE roster.member_id=member.id AND roster.league_season_id=season.id)) ORDER BY member.id),'[]'::jsonb)
      FROM public.league_members member LEFT JOIN LATERAL (SELECT wins,ties FROM public.standings
        WHERE member_id=member.id AND league_season_id=season.id ORDER BY week_number DESC LIMIT 1) record ON true
      WHERE member.league_id=p_league_id),
    'games',(SELECT COALESCE(jsonb_agg(jsonb_build_object('home',home_member_id,'away',away_member_id) ORDER BY id),'[]'::jsonb)
      FROM public.matchups WHERE league_season_id=season.id AND matchup_type='regular_season' AND NOT is_finalized AND NOT is_voided),
    'picks',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'draftYear',pick.season_year,'round',pick.round,
      'originalOwnerId',pick.original_owner_id,'slot',slot.pick_in_round,
      'bands',(SELECT jsonb_object_agg(value.tier,value.trade_value) FROM bands value
        WHERE value.round=pick.round AND value.draft_year=(SELECT band.draft_year FROM bands band
          WHERE band.round=pick.round ORDER BY abs(band.draft_year-(pick.season_year)),band.draft_year LIMIT 1))) ORDER BY pick.id),'[]'::jsonb) FROM public.draft_picks pick
      LEFT JOIN LATERAL (SELECT pick_in_round FROM public.snake_draft_picks WHERE draft_pick_id=pick.id ORDER BY picked_at DESC NULLS LAST,id LIMIT 1) slot ON true
      WHERE pick.league_id=p_league_id AND pick.round BETWEEN 1 AND 3)) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_trade_pick_years()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE league uuid; document jsonb; location text[]; pick jsonb; year integer;
BEGIN
  IF TG_TABLE_NAME='trade_estimate_quotes' THEN
    league:=NEW.league_id;
    document:=jsonb_build_object('inputs',NEW.inputs);
  ELSE
    SELECT league_id INTO STRICT league FROM public.trades WHERE id=NEW.trade_id;
    document:=NEW.snapshot;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('draft-pick-calendar-years:'||league::text,0));
  FOR location IN SELECT ARRAY['inputs','picks'] UNION ALL SELECT ARRAY['quote','inputs','picks'] LOOP
    IF document#>location IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(document#>location) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Draft pick years changed. Refresh the trade estimate and try again.' USING ERRCODE='22023';
    END IF;
    FOR pick IN SELECT value FROM jsonb_array_elements(document#>location) LOOP
      SELECT season_year INTO year FROM public.draft_picks
        WHERE id::text=pick->>'id' AND league_id=league FOR SHARE;
      IF NOT FOUND OR jsonb_typeof(pick->'seasonYear') IS DISTINCT FROM 'number'
        OR pick->>'seasonYear' IS DISTINCT FROM year::text THEN
        RAISE EXCEPTION 'Draft pick years changed. Refresh the trade estimate and try again.' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.guard_trade_pick_years() FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS private.draft_pick_calendar_repairs (
  league_id uuid PRIMARY KEY REFERENCES public.leagues(id) ON DELETE CASCADE,
  before_sha256 text NOT NULL,
  after_sha256 text NOT NULL,
  pick_count integer NOT NULL,
  reference_changes jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE private.draft_pick_calendar_repairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.draft_pick_calendar_repairs FROM PUBLIC,anon,authenticated,service_role;

DO $repair$
DECLARE
  v_league uuid := 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd';
  v_before constant text := '179d1bdf6ec734b0379814aa5de822049c8fb54f68e0a96bd6e6227fb0a4fbd1';
  v_after constant text := '8fb7196bb3b7c7d0d42ffb7c4048850cf36ab05c74a58751835a6389ff743b2d';
  v_hash text;
  v_count integer;
  v_years jsonb;
  v_document record;
  v_location record;
  v_pick record;
  v_value jsonb;
  v_path text[];
  v_old integer;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('draft-pick-calendar-years:'||v_league::text,0));
  PERFORM 1 FROM public.leagues WHERE id=v_league FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.leagues) THEN
      RAISE EXCEPTION 'Draft-pick calendar repair target missing from populated database';
    END IF;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM private.draft_pick_calendar_repairs WHERE league_id=v_league) THEN
    IF NOT EXISTS(SELECT 1 FROM private.draft_pick_calendar_repairs
      WHERE league_id=v_league AND before_sha256=v_before AND after_sha256=v_after AND pick_count=150) THEN
      RAISE EXCEPTION 'Unexpected draft-pick calendar repair receipt';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.leagues league JOIN public.league_seasons season
    ON season.league_id=league.id AND season.is_current
    WHERE league.id=v_league AND league.future_pick_years=5 AND season.season_year=2027) THEN
    RAISE EXCEPTION 'Draft-pick calendar repair league state changed';
  END IF;
  PERFORM 1 FROM public.draft_picks WHERE league_id=v_league ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.trade_estimate_quotes WHERE league_id=v_league ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.trade_estimate_history history JOIN public.trades trade ON trade.id=history.trade_id
    WHERE trade.league_id=v_league ORDER BY history.trade_id,history.formula_version FOR UPDATE OF history;
  PERFORM 1 FROM public.trade_value_cache WHERE league_id=v_league ORDER BY trade_id FOR UPDATE;
  SELECT count(*),encode(sha256(convert_to(string_agg(jsonb_build_array(id,season_year,round,
    original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id)::text,E'\n' ORDER BY id),'UTF8')),'hex'),
    jsonb_object_agg(id::text,season_year)
  INTO v_count,v_hash,v_years FROM public.draft_picks WHERE league_id=v_league;
  IF v_count<>150 OR v_hash IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'Draft-pick calendar repair before-state mismatch';
  END IF;

  FOR v_document IN
    SELECT 'quote' AS kind,quote.id::text AS id,NULL::text AS formula_version,
      jsonb_build_object('inputs',quote.inputs) AS document FROM public.trade_estimate_quotes quote WHERE quote.league_id=v_league
    UNION ALL
    SELECT 'history',history.trade_id::text,history.formula_version,history.snapshot
      FROM public.trade_estimate_history history JOIN public.trades trade ON trade.id=history.trade_id WHERE trade.league_id=v_league
    ORDER BY kind,id,formula_version
  LOOP
    v_value:=v_document.document;
    FOR v_location IN SELECT ARRAY['inputs','picks'] AS path UNION ALL SELECT ARRAY['quote','inputs','picks'] LOOP
      IF v_value#>v_location.path IS NULL THEN CONTINUE; END IF;
      IF jsonb_typeof(v_value#>v_location.path) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Draft-pick calendar repair input shape changed';
      END IF;
      FOR v_pick IN SELECT value,ordinality FROM jsonb_array_elements(v_value#>v_location.path) WITH ORDINALITY LOOP
        IF NOT(v_years ? COALESCE(v_pick.value->>'id',''))
          OR jsonb_typeof(v_pick.value->'seasonYear') IS DISTINCT FROM 'number'
          OR (v_pick.value->>'seasonYear') IS DISTINCT FROM (v_years->>(v_pick.value->>'id')) THEN
          RAISE EXCEPTION 'Draft-pick calendar repair reference before-state mismatch';
        END IF;
        v_old:=(v_pick.value->>'seasonYear')::integer;
        v_path:=v_location.path||ARRAY[(v_pick.ordinality-1)::text,'seasonYear'];
        v_value:=jsonb_set(v_value,v_path,to_jsonb(v_old-1));
        v_changes:=v_changes||jsonb_build_array(jsonb_build_object('kind',v_document.kind,'id',v_document.id,
          'formula_version',v_document.formula_version,'path',v_path,'before',v_old,'after',v_old-1));
      END LOOP;
    END LOOP;
    IF v_value IS DISTINCT FROM v_document.document THEN
      IF v_document.kind='quote' THEN
        UPDATE public.trade_estimate_quotes SET inputs=v_value->'inputs' WHERE id=v_document.id::uuid AND league_id=v_league;
      ELSE
        UPDATE public.trade_estimate_history SET snapshot=v_value
          WHERE trade_id=v_document.id::uuid AND formula_version=v_document.formula_version;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.draft_picks SET season_year=season_year+10000 WHERE league_id=v_league;
  UPDATE public.draft_picks SET season_year=season_year-10001 WHERE league_id=v_league;
  SELECT count(*),encode(sha256(convert_to(string_agg(jsonb_build_array(id,season_year,round,
    original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id)::text,E'\n' ORDER BY id),'UTF8')),'hex')
  INTO v_count,v_hash FROM public.draft_picks WHERE league_id=v_league;
  IF v_count<>150 OR v_hash IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'Draft-pick calendar repair after-state mismatch';
  END IF;
  UPDATE public.trade_value_cache SET valid_until=LEAST(valid_until,transaction_timestamp()) WHERE league_id=v_league;
  INSERT INTO private.draft_pick_calendar_repairs(league_id,before_sha256,after_sha256,pick_count,reference_changes)
    VALUES(v_league,v_before,v_after,v_count,v_changes);
END;
$repair$;

CREATE TRIGGER guard_trade_pick_years BEFORE INSERT OR UPDATE OF inputs,league_id ON public.trade_estimate_quotes
FOR EACH ROW EXECUTE FUNCTION private.guard_trade_pick_years();
CREATE TRIGGER guard_trade_pick_years BEFORE INSERT OR UPDATE OF snapshot,trade_id ON public.trade_estimate_history
FOR EACH ROW EXECUTE FUNCTION private.guard_trade_pick_years();

COMMIT;
