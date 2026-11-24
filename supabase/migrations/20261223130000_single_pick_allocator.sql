CREATE OR REPLACE FUNCTION private.draft_year_for_season(p_season_year int)
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT p_season_year - 1
$$;

CREATE OR REPLACE FUNCTION private.season_year_after(p_season_year int, p_now timestamptz DEFAULT now())
RETURNS int
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT GREATEST(p_season_year + 1, public.current_season_year_et(p_now))
$$;

CREATE OR REPLACE FUNCTION private.future_pick_window(p_league_id uuid, OUT first_draft_year int, OUT last_draft_year int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    CASE WHEN EXISTS (
      SELECT 1 FROM public.league_seasons earlier
      WHERE earlier.league_id=season.league_id AND earlier.season_year<season.season_year
    ) THEN private.draft_year_for_season(season.season_year) ELSE season.season_year END,
    season.season_year+league.future_pick_years-1
  FROM public.leagues league
  JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
  WHERE league.id=p_league_id
$$;

CREATE OR REPLACE FUNCTION private.reconcile_future_picks(p_league_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rounds constant int := 3;
  v_first int;
  v_last int;
  v_reference record;
  v_predicate text := '';
BEGIN
  PERFORM 1 FROM public.leagues WHERE id=p_league_id FOR UPDATE;
  SELECT window_years.first_draft_year,window_years.last_draft_year INTO v_first,v_last
  FROM private.future_pick_window(p_league_id) window_years;
  IF v_first IS NULL THEN RETURN; END IF;

  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT p_league_id,year_value,round_value,member.id,member.id
  FROM public.league_members member
  CROSS JOIN generate_series(v_first,v_last) year_value
  CROSS JOIN generate_series(1,v_rounds) round_value
  WHERE member.league_id=p_league_id
  ON CONFLICT(league_id,season_year,round,original_owner_id) DO NOTHING;

  PERFORM 1 FROM public.draft_picks pick
  WHERE pick.league_id=p_league_id AND pick.season_year>v_last
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
    USING p_league_id,v_last;
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
    WHERE pick.league_id=p_league_id AND pick.id=ANY(p_pick_ids) AND pick.season_year<private.draft_year_for_season(season.season_year)
  ) THEN
    RAISE EXCEPTION 'Picks from past seasons cannot be traded.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_picks pick CROSS JOIN private.future_pick_window(p_league_id) window_years
    WHERE pick.league_id=p_league_id AND pick.id=ANY(p_pick_ids) AND pick.season_year>window_years.last_draft_year
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
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', v_team_name)
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_season_id, v_member_id, 1);

  PERFORM private.reconcile_future_picks(v_league_id);

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

  SELECT id
  INTO   v_league_season_id
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

  PERFORM private.reconcile_future_picks(v_league.id);

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

  v_new_year := private.season_year_after(v_current_season.season_year, now());

  UPDATE draft_picks SET is_used=true,used_at=now()
    WHERE league_id=p_league_id AND season_year<private.draft_year_for_season(v_new_year) AND NOT is_used;

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

  PERFORM private.reconcile_future_picks(p_league_id);

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
       AND pick.season_year = private.draft_year_for_season(v_season.season_year)
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
           AND season_year = private.draft_year_for_season(v_season.season_year)
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
      WHERE league_id=p_league_id AND season_year=private.draft_year_for_season(v_season.season_year) AND round>p_rounds AND NOT is_used;
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
         AND season_year = private.draft_year_for_season(v_season_year)
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
      SELECT max(pick.season_year-private.draft_year_for_season(season.season_year)) INTO v_required_pick_years
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

REVOKE ALL ON FUNCTION private.draft_year_for_season(int) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.season_year_after(int,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.future_pick_window(uuid) FROM PUBLIC,anon,authenticated,service_role;
