-- Canonical SQL source for dynasty transactions and settings.
-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies the latest migration definitions still match.

CREATE OR REPLACE FUNCTION private.current_add_week_number(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS int
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_season_year int;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_week int;
BEGIN
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id;

  IF v_season_year IS NULL THEN
    RETURN 1;
  END IF;

  SELECT week_number
    INTO v_week
    FROM season_weeks
   WHERE season_year = v_season_year
     AND week_start <= v_today
     AND week_end >= v_today
   ORDER BY week_number
   LIMIT 1;

  IF v_week IS NOT NULL THEN
    RETURN v_week;
  END IF;

  SELECT week_number
    INTO v_week
    FROM season_weeks
   WHERE season_year = v_season_year
     AND week_end >= v_today
   ORDER BY week_start
   LIMIT 1;

  IF v_week IS NOT NULL THEN
    RETURN v_week;
  END IF;

  SELECT max(week_number)
    INTO v_week
    FROM season_weeks
   WHERE season_year = v_season_year;

  RETURN COALESCE(v_week, 1);
END;
$$;

CREATE OR REPLACE FUNCTION private.ensure_faab_balance(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS int
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_balance int;
  v_starting_budget int;
BEGIN
  SELECT balance
    INTO v_balance
    FROM faab_balances
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id
   FOR UPDATE;

  IF FOUND THEN
    RETURN v_balance;
  END IF;

  SELECT faab_starting_budget
    INTO v_starting_budget
    FROM leagues
   WHERE id = p_league_id;

  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    COALESCE(v_starting_budget, 100)
  )
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET updated_at = now()
  RETURNING balance INTO v_balance;

  RETURN v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION private.ensure_season_faab_balances(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  SELECT
    member.league_id,
    p_league_season_id,
    member.id,
    league.faab_starting_budget
  FROM league_members AS member
  JOIN leagues AS league ON league.id = member.league_id
  WHERE member.league_id = p_league_id
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT format('Weekly add limit reached (%s/%s adds used this week).', p_used, p_limit);
$$;

CREATE OR REPLACE FUNCTION private.assert_weekly_add_available(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_week int;
  v_used int;
BEGIN
  SELECT weekly_add_limit
    INTO v_limit
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF v_limit IS NULL THEN
    RETURN;
  END IF;

  v_week := private.current_add_week_number(p_league_id, p_league_season_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  SELECT count_row.add_count
    INTO v_used
    FROM weekly_add_counts AS count_row
   WHERE count_row.league_id = p_league_id
     AND count_row.league_season_id = p_league_season_id
     AND count_row.member_id = p_member_id
     AND count_row.week_number = v_week
   FOR UPDATE;

  IF COALESCE(v_used, 0) >= v_limit THEN
    RAISE EXCEPTION '%', private.weekly_add_limit_message(COALESCE(v_used, 0), v_limit)
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.consume_weekly_add(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_week int;
BEGIN
  SELECT weekly_add_limit
    INTO v_limit
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF v_limit IS NULL THEN
    RETURN;
  END IF;

  PERFORM private.assert_weekly_add_available(p_league_id, p_league_season_id, p_member_id);
  v_week := private.current_add_week_number(p_league_id, p_league_season_id);

  UPDATE weekly_add_counts AS count_row
     SET add_count = count_row.add_count + 1,
         updated_at = now()
   WHERE count_row.league_id = p_league_id
     AND count_row.league_season_id = p_league_season_id
     AND count_row.member_id = p_member_id
     AND count_row.week_number = v_week;
END;
$$;

CREATE OR REPLACE FUNCTION private.log_league_activity(
  p_league_id uuid,
  p_league_season_id uuid,
  p_event_type text,
  p_title text,
  p_body text DEFAULT NULL,
  p_actor_member_id uuid DEFAULT NULL,
  p_target_member_id uuid DEFAULT NULL,
  p_related_player_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_related_claim_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    related_claim_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_actor_member_id,
    p_target_member_id,
    p_related_player_id,
    p_related_trade_id,
    p_related_claim_id,
    p_event_type,
    p_title,
    p_body,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_league_activity_feed(
  p_league_id uuid,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  member_id uuid,
  target_member_id uuid,
  team_name text,
  target_team_name text,
  player_id uuid,
  player_name text,
  player_position text,
  eligible_positions text[],
  nba_id text,
  transaction_type text,
  occurred_at timestamptz,
  is_system boolean,
  title text,
  body text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH current_season AS (
    SELECT season.id
      FROM league_seasons AS season
     WHERE season.league_id = p_league_id
       AND season.is_current = true
     LIMIT 1
  ),
  feed AS (
    SELECT
      tx.id,
      tx.member_id,
      NULL::uuid AS target_member_id,
      member.team_name::text AS team_name,
      NULL::text AS target_team_name,
      tx.player_id,
      player.display_name::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      tx.transaction_type::text AS transaction_type,
      tx.occurred_at,
      false AS is_system,
      NULL::text AS title,
      NULL::text AS body
    FROM roster_transactions AS tx
    JOIN current_season ON current_season.id = tx.league_season_id
    LEFT JOIN league_members AS member ON member.id = tx.member_id
    LEFT JOIN players AS player ON player.id = tx.player_id
    WHERE tx.league_id = p_league_id
      AND tx.transaction_type IN ('fa_add', 'fa_drop', 'waiver_add', 'waiver_drop', 'trade_in', 'trade_out', 'draft_won', 'carry_over')

    UNION ALL

    SELECT
      activity.id,
      activity.actor_member_id AS member_id,
      activity.target_member_id,
      COALESCE(actor.team_name, 'League')::text AS team_name,
      target.team_name::text AS target_team_name,
      activity.related_player_id AS player_id,
      COALESCE(player.display_name, activity.title)::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      activity.event_type::text AS transaction_type,
      activity.created_at AS occurred_at,
      true AS is_system,
      activity.title,
      activity.body
    FROM league_activity AS activity
    JOIN current_season
      ON activity.league_season_id = current_season.id
      OR activity.league_season_id IS NULL
    LEFT JOIN league_members AS actor ON actor.id = activity.actor_member_id
    LEFT JOIN league_members AS target ON target.id = activity.target_member_id
    LEFT JOIN players AS player ON player.id = activity.related_player_id
    WHERE activity.league_id = p_league_id
  )
  SELECT
    feed.id,
    feed.member_id,
    feed.target_member_id,
    feed.team_name,
    feed.target_team_name,
    feed.player_id,
    feed.player_name,
    feed.player_position,
    feed.eligible_positions,
    feed.nba_id,
    feed.transaction_type,
    feed.occurred_at,
    feed.is_system,
    feed.title,
    feed.body
  FROM feed
  ORDER BY feed.occurred_at DESC, feed.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_member_transaction_state(
  p_member_id uuid,
  p_league_id uuid
)
RETURNS TABLE (
  league_season_id uuid,
  week_number int,
  weekly_add_limit int,
  weekly_add_count int,
  waiver_mode text,
  faab_starting_budget int,
  faab_balance int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_balance int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  v_week := private.current_add_week_number(p_league_id, v_season_id);
  v_balance := private.ensure_faab_balance(p_league_id, v_season_id, p_member_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  RETURN QUERY
  SELECT
    v_season_id,
    v_week,
    league.weekly_add_limit,
    count_row.add_count,
    league.waiver_mode,
    league.faab_starting_budget,
    v_balance
  FROM leagues AS league
  JOIN weekly_add_counts AS count_row
    ON count_row.league_id = league.id
   AND count_row.league_season_id = v_season_id
   AND count_row.member_id = p_member_id
   AND count_row.week_number = v_week
  WHERE league.id = p_league_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.commissioner_adjust_faab_balance_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_balance int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_balance int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_balance IS NULL OR p_balance < 0 THEN
    RAISE EXCEPTION 'FAAB balance must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can adjust FAAB balances.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_balance
  )
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET balance = EXCLUDED.balance,
         updated_at = now()
  RETURNING balance INTO v_balance;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'commissioner_faab_adjusted',
    'FAAB balance adjusted',
    NULL,
    NULL,
    p_member_id,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('balance', v_balance)
  );

  RETURN v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.commissioner_override_weekly_add_count_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_add_count int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_add_count IS NULL OR p_add_count < 0 THEN
    RAISE EXCEPTION 'Current-week add count must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can override add counts.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_week := private.current_add_week_number(p_league_id, v_season_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    v_week,
    p_add_count
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO UPDATE
     SET add_count = EXCLUDED.add_count,
         updated_at = now()
  RETURNING add_count INTO v_count;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'commissioner_add_count_override',
    'Weekly add count overridden',
    NULL,
    NULL,
    p_member_id,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('week_number', v_week, 'add_count', v_count)
  );

  RETURN v_count;
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
  v_scoring_settings jsonb;
  v_roster_size int;
  v_ir_slots int;
  v_taxi_slots int;
  v_auction_budget int;
  v_playoff_start_week int;
  v_trade_deadline timestamptz;
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

  IF p_settings ? 'playoff_start_week' AND jsonb_typeof(p_settings -> 'playoff_start_week') = 'number' THEN
    v_playoff_start_week := (p_settings ->> 'playoff_start_week')::int;
    IF v_playoff_start_week <= 0 THEN
      RAISE EXCEPTION 'playoff_start_week must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_deadline' AND p_settings -> 'trade_deadline' IS NOT NULL THEN
    IF jsonb_typeof(p_settings -> 'trade_deadline') <> 'string' THEN
      RAISE EXCEPTION 'trade_deadline must be an ISO 8601 timestamp string.'
        USING ERRCODE = '22023';
    END IF;
    v_trade_deadline := (p_settings ->> 'trade_deadline')::timestamptz;
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
    OR v_auction_budget IS NOT NULL;

  IF v_touches_structural
     AND v_league.status IS DISTINCT FROM 'setup'::public.league_status
  THEN
    RAISE EXCEPTION
      'Structural league settings (scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget) can only be changed before the draft starts.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.leagues
     SET scoring_settings = COALESCE(v_scoring_settings, scoring_settings),
         roster_size = COALESCE(v_roster_size, roster_size),
         ir_slots = COALESCE(v_ir_slots, ir_slots),
         taxi_slots = COALESCE(v_taxi_slots, taxi_slots),
         auction_budget = COALESCE(v_auction_budget, auction_budget),
         playoff_start_week = COALESCE(v_playoff_start_week, playoff_start_week),
         trade_deadline = COALESCE(v_trade_deadline, trade_deadline),
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
