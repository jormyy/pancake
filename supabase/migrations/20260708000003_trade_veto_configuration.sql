-- Configurable trade veto settings. Defaults preserve the prior behavior:
-- member voting, 24-hour window, and a 50% non-party threshold.

ALTER TABLE public.leagues
  ADD COLUMN IF NOT EXISTS trade_veto_mode text NOT NULL DEFAULT 'member_vote';

ALTER TABLE public.leagues
  ADD COLUMN IF NOT EXISTS trade_veto_window_hours int NOT NULL DEFAULT 24;

ALTER TABLE public.leagues
  ADD COLUMN IF NOT EXISTS trade_veto_threshold_percent int NOT NULL DEFAULT 50;

ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_trade_veto_mode_check;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_trade_veto_mode_check
  CHECK (trade_veto_mode IN ('disabled', 'commissioner', 'member_vote'));

ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_trade_veto_window_hours_check;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_trade_veto_window_hours_check
  CHECK (trade_veto_window_hours BETWEEN 0 AND 168);

ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_trade_veto_threshold_percent_check;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_trade_veto_threshold_percent_check
  CHECK (trade_veto_threshold_percent BETWEEN 1 AND 100);

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
  v_veto_window_hours int;
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

  v_veto_window_hours := CASE
    WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
    ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
  END;

  UPDATE trades
     SET status = 'accepted',
         accepted_at = now(),
         veto_window_expires_at = now() + make_interval(hours => v_veto_window_hours),
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
  v_is_trade_party := v_member.id IN (v_trade.proposer_member_id, v_trade.recipient_member_id);

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' AND NOT v_is_commissioner THEN
    RAISE EXCEPTION 'Only commissioners can veto trades in this league.'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_trade_party AND NOT v_is_commissioner THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.'
      USING ERRCODE = 'P0001';
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
    FROM league_members
   WHERE league_id = v_trade.league_id
     AND id NOT IN (v_trade.proposer_member_id, v_trade.recipient_member_id);

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
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_league_settings_atomic(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_league_settings_atomic(uuid, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.veto_trade_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.veto_trade_atomic(uuid, uuid) TO service_role;
