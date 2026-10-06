-- League season rules.
--
-- 1. The trade deadline repeats every season. leagues.trade_deadline held one
--    fixed date, so after a season it stayed in the past and locked trades
--    for the whole next season. It is still stored as a date, but now always
--    as the date inside the league's current season: the commissioner sets a
--    month and day, advancing a season carries it forward, and a deadline
--    saved in an earlier season moves into the current one.
-- 2. create_league gives the commissioner the first waiver spot. Since
--    20260709100018 it gave none, and process_next_waiver_claim_atomic joins
--    waiver_priorities, so a commissioner's claims never processed. The
--    backfill appends any member without a spot to the end of the order.
-- 3. A league is set up for the season it will play. The calendar season
--    flips on Oct 1 ET, so a league created in the offseason landed on the
--    season that had just ended. create_league now uses the next season once
--    the current one's last week has ended, and the daily season-boundary
--    tick moves a setup league that never drafted or played off a finished
--    season.
-- 4. prune_unbounded_history keeps 30 days of cron.job_run_details. pg_cron
--    never prunes it, and it had grown to 488k rows (128 MB, 42% of the
--    database) by 2026-10-06.
-- Canonical sources: supabase/sql/functions/by-name/private/{trade_deadline_for_season,
-- setup_season_year_et,roll_setup_league_seasons}.sql and
-- supabase/sql/functions/by-name/public/{create_league,update_league_settings_atomic,
-- advance_season_atomic,invoke_season_boundary_if_due,prune_unbounded_history}.sql


CREATE OR REPLACE FUNCTION private.trade_deadline_for_season(
  p_deadline date,
  p_season_year int
)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  -- A league's trade deadline is a month and day that repeats every season.
  -- Season N runs from October of N-1 through September of N, matching
  -- current_season_year_et(). Feb 29 falls back to Feb 28 in other years.
  SELECT (
    anchor.month_start
    + least(
        extract(day FROM p_deadline)::int,
        extract(day FROM anchor.month_start + interval '1 month - 1 day')::int
      )
    - 1
  )
    FROM (
      SELECT make_date(
        CASE WHEN extract(month FROM p_deadline) >= 10 THEN p_season_year - 1 ELSE p_season_year END,
        extract(month FROM p_deadline)::int,
        1
      ) AS month_start
    ) AS anchor
   WHERE p_deadline IS NOT NULL
     AND p_season_year IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION private.setup_season_year_et(p_now timestamptz DEFAULT now())
RETURNS int
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  -- current_season_year_et() flips on Oct 1 ET. A league set up after the
  -- current season's last week has ended plays the next season instead.
  SELECT CASE
    WHEN (
      SELECT max(week.week_end)
        FROM public.season_weeks AS week
       WHERE week.season_year = calendar.season_year
    ) < timezone('America/New_York', p_now)::date
      THEN calendar.season_year + 1
    ELSE calendar.season_year
  END
    FROM (SELECT public.current_season_year_et(p_now) AS season_year) AS calendar;
$$;

CREATE OR REPLACE FUNCTION private.roll_setup_league_seasons(p_now timestamptz DEFAULT now())
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_year int := private.setup_season_year_et(p_now);
  v_season record;
  v_shift int;
  v_rolled int := 0;
BEGIN
  -- A league still in setup has not drafted or played. If its season is
  -- already over, move it to the season it will actually play, in place, so
  -- members, waiver spots, and FAAB balances stay attached.
  FOR v_season IN
    SELECT season.id, season.league_id, season.season_year
      FROM public.league_seasons AS season
      JOIN public.leagues AS league
        ON league.id = season.league_id
     WHERE season.is_current
       AND season.season_year < v_target_year
       AND league.status = 'setup'::public.league_status
       AND league.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.roster_players AS roster WHERE roster.league_season_id = season.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.matchups AS matchup WHERE matchup.league_season_id = season.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.league_seasons AS later
          WHERE later.league_id = season.league_id
            AND later.season_year >= v_target_year
       )
     ORDER BY season.league_id
     FOR UPDATE OF season, league
  LOOP
    v_shift := v_target_year - v_season.season_year;

    UPDATE public.league_seasons
       SET season_year = v_target_year
     WHERE id = v_season.id;

    -- Future picks move with the season. Two passes keep the
    -- (league, year, round, owner) key unique while rows shift.
    UPDATE public.draft_picks
       SET season_year = season_year + v_shift + 10000
     WHERE league_id = v_season.league_id;
    UPDATE public.draft_picks
       SET season_year = season_year - 10000
     WHERE league_id = v_season.league_id;

    UPDATE public.leagues
       SET trade_deadline = private.trade_deadline_for_season(trade_deadline, v_target_year)
     WHERE id = v_season.league_id;

    v_rolled := v_rolled + 1;
  END LOOP;

  RETURN v_rolled;
END;
$$;

REVOKE ALL ON FUNCTION private.trade_deadline_for_season(date, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.setup_season_year_et(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.roll_setup_league_seasons(timestamptz) FROM PUBLIC;

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
  v_season_id    uuid;
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

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', trim(p_team_name))
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_season_id;

  -- Waiver claims process only for members with a waiver spot; joiners line
  -- up behind the commissioner.
  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_season_id, v_member_id, 1);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, year_value, round_value, v_member_id, v_member_id
    FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
   CROSS JOIN generate_series(1, 3) AS round_value;

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

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current, rookie_draft_scheduled_at)
  VALUES (p_league_id, v_new_year, true, now() + interval '60 days')
  RETURNING id INTO v_new_season_id;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
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

  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    v_far_year,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
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
          COALESCE(ls.wins, 0) ASC,
          COALESCE(ls.points_for, 0) ASC,
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

  IF NOT EXISTS (
    SELECT 1
      FROM public.leagues
     WHERE status IN (
       'active'::public.league_status,
       'playoffs'::public.league_status,
       'offseason'::public.league_status
     )
  ) THEN
    RETURN;
  END IF;

  IF NOT private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM public.invoke_edge_function('season-boundary');
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sync_runs bigint;
  v_projection_runs bigint;
  v_weekly_lineups bigint;
  v_standings bigint;
  v_roster_transactions bigint;
  v_dynasty_news bigint;
  v_cron_runs bigint := 0;
BEGIN
  DELETE FROM public.sync_runs
   WHERE started_at < now() - interval '90 days';
  GET DIAGNOSTICS v_sync_runs = ROW_COUNT;

  -- fantasypros_projection_rows cascades from its run (ON DELETE CASCADE);
  -- product queries only read the latest run per date.
  DELETE FROM public.projection_sync_runs
   WHERE started_at < now() - interval '30 days';
  GET DIAGNOSTICS v_projection_runs = ROW_COUNT;

  -- Per-league season recency: rn 1 = current/most recent season.
  CREATE TEMP TABLE IF NOT EXISTS pruning_season_ranks ON COMMIT DROP AS
  SELECT
    id,
    league_id,
    row_number() OVER (PARTITION BY league_id ORDER BY season_year DESC) AS rn
  FROM public.league_seasons;

  -- Lineups are only read for the current matchup views; keep two seasons.
  DELETE FROM public.weekly_lineups AS wl
   USING pruning_season_ranks AS ranked
   WHERE wl.league_season_id = ranked.id
     AND ranked.rn > 2;
  GET DIAGNOSTICS v_weekly_lineups = ROW_COUNT;

  -- Old seasons keep each member's final standings snapshot (history and
  -- champion views read it); intermediate weekly snapshots are never shown.
  DELETE FROM public.standings AS s
   USING pruning_season_ranks AS ranked
   WHERE s.league_season_id = ranked.id
     AND ranked.rn > 2
     AND s.week_number < (
       SELECT max(inner_s.week_number)
         FROM public.standings AS inner_s
        WHERE inner_s.league_season_id = s.league_season_id
          AND inner_s.member_id = s.member_id
     );
  GET DIAGNOSTICS v_standings = ROW_COUNT;

  -- News feed shows a bounded recent list; keep 60 days.
  DELETE FROM public.dynasty_news
   WHERE published_at < now() - interval '60 days';
  GET DIAGNOSTICS v_dynasty_news = ROW_COUNT;

  -- Transaction history UI pages recent activity; keep three seasons.
  DELETE FROM public.roster_transactions AS rt
   USING pruning_season_ranks AS ranked
   WHERE rt.league_season_id = ranked.id
     AND ranked.rn > 3;
  GET DIAGNOSTICS v_roster_transactions = ROW_COUNT;

  DROP TABLE IF EXISTS pruning_season_ranks;

  -- pg_cron logs every run and never prunes it; the per-minute jobs add
  -- about 4,400 rows a day. Keep 30 days for debugging.
  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    DELETE FROM cron.job_run_details
     WHERE start_time < now() - interval '30 days';
    GET DIAGNOSTICS v_cron_runs = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'sync_runs', v_sync_runs,
    'projection_sync_runs', v_projection_runs,
    'weekly_lineups', v_weekly_lineups,
    'standings', v_standings,
    'roster_transactions', v_roster_transactions,
    'dynasty_news', v_dynasty_news,
    'cron_job_run_details', v_cron_runs
  );
END;
$$;

-- Members without a waiver spot in their league's current season join the
-- end of the order, in join order.
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
SELECT
  member.league_id,
  season.id,
  member.id,
  COALESCE((
    SELECT max(priority.priority)
      FROM public.waiver_priorities AS priority
     WHERE priority.league_id = member.league_id
       AND priority.league_season_id = season.id
  ), 0) + row_number() OVER (PARTITION BY season.id ORDER BY member.joined_at, member.id)
  FROM public.league_members AS member
  JOIN public.league_seasons AS season
    ON season.league_id = member.league_id
   AND season.is_current
  JOIN public.leagues AS league
    ON league.id = member.league_id
 WHERE league.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.waiver_priorities AS priority
      WHERE priority.league_id = member.league_id
        AND priority.league_season_id = season.id
        AND priority.member_id = member.id
   );

-- Leagues already stranded on a finished season move now.
SELECT private.roll_setup_league_seasons();

-- A deadline saved in an earlier season moves into the league's current one.
UPDATE public.leagues AS league
   SET trade_deadline = private.trade_deadline_for_season(league.trade_deadline, season.season_year)
  FROM public.league_seasons AS season
 WHERE season.league_id = league.id
   AND season.is_current
   AND league.trade_deadline IS NOT NULL
   AND league.trade_deadline IS DISTINCT FROM private.trade_deadline_for_season(league.trade_deadline, season.season_year);
