-- One owner for "did this pick leave its owner" and for "is this asset
-- reserved by another accepted trade".
--
-- private.pick_left_owner is the single rule the pick-listing sync and the
-- accepted-trade pick guard both read. private.is_reserved_trade_asset gains
-- p_exclude_trade_id so trade acceptance asks the same helper as every roster
-- move instead of carrying its own copy of the reservation query.
-- private.current_add_week is the one add-week lookup for the limit check.
-- The add-side lineup clears are gone: sync_roster_linked_state already clears
-- future unlocked lineups whenever a player leaves a roster, so an add has
-- nothing stale to remove.


CREATE OR REPLACE FUNCTION private.pick_left_owner(
  p_old draft_picks,
  p_new draft_picks
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- A pick leaves its owner's hands when ownership changes or it is used in a draft.
  SELECT p_old.current_owner_id IS DISTINCT FROM p_new.current_owner_id
      OR (p_new.is_used = true AND p_old.is_used IS DISTINCT FROM p_new.is_used)
$$;

DROP FUNCTION IF EXISTS private.is_reserved_trade_asset(uuid, uuid, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION private.is_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = p_league_id
       AND (p_league_season_id IS NULL OR trade.league_season_id = p_league_season_id)
       AND (p_exclude_trade_id IS NULL OR trade.id <> p_exclude_trade_id)
       AND item.from_member_id = p_member_id
       AND (
         (p_player_id IS NOT NULL AND item.player_id = p_player_id)
         OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF private.trade_lifecycle_write_active() THEN
    RETURN NEW;
  END IF;

  IF private.pick_left_owner(OLD, NEW)
     AND private.is_reserved_trade_asset(OLD.league_id, NULL, OLD.current_owner_id, NULL, OLD.id) THEN
    RAISE EXCEPTION 'This pick is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_trade_block_on_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_consumed boolean := NEW.is_used = true AND OLD.is_used IS DISTINCT FROM NEW.is_used;
BEGIN
  IF NOT private.pick_left_owner(OLD, NEW) THEN
    RETURN NULL;
  END IF;

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND pick_id = OLD.id
     AND (v_consumed OR member_id = OLD.current_owner_id);

  PERFORM private.expire_pending_trades_for_lost_asset(
    OLD.league_id,
    OLD.current_owner_id,
    NULL,
    OLD.id,
    v_consumed
  );

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.current_add_week(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS TABLE (
  week_number int,
  resets_at timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_zone text := private.add_week_timezone();
  v_today date := (now() AT TIME ZONE v_zone)::date;
  v_season_year int;
  v_week int;
  v_week_end date;
  v_last_week int;
  v_last_end date;
  v_elapsed_weeks int;
BEGIN
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id;

  IF v_season_year IS NULL THEN
    RETURN QUERY SELECT 1, NULL::timestamptz;
    RETURN;
  END IF;

  -- Inside a scheduled week, or before the next scheduled week starts, the
  -- count belongs to that week and resets at midnight the day after it ends.
  SELECT weeks.week_number, weeks.week_end
    INTO v_week, v_week_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year
     AND weeks.week_start <= v_today
     AND weeks.week_end >= v_today
   ORDER BY weeks.week_number
   LIMIT 1;

  IF v_week IS NULL THEN
    SELECT weeks.week_number, weeks.week_end
      INTO v_week, v_week_end
      FROM season_weeks AS weeks
     WHERE weeks.season_year = v_season_year
       AND weeks.week_end >= v_today
     ORDER BY weeks.week_start
     LIMIT 1;
  END IF;

  IF v_week IS NOT NULL THEN
    RETURN QUERY SELECT v_week, (v_week_end + 1)::timestamp AT TIME ZONE v_zone;
    RETURN;
  END IF;

  -- Every scheduled week has ended: the number keeps advancing every 7 days
  -- from the day after the last one, so limits still reset in the playoffs and
  -- the offseason. A new season with no schedule yet (rollover happens months
  -- before the NBA publishes one) anchors on the prior season instead; the
  -- 1000 offset keeps those numbers clear of the real ones that arrive in October.
  SELECT max(weeks.week_number), max(weeks.week_end)
    INTO v_last_week, v_last_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year;

  IF v_last_week IS NOT NULL THEN
    v_elapsed_weeks := (v_today - v_last_end - 1) / 7;
    RETURN QUERY SELECT v_last_week + 1 + v_elapsed_weeks,
      (v_last_end + 1 + (v_elapsed_weeks + 1) * 7)::timestamp AT TIME ZONE v_zone;
    RETURN;
  END IF;

  SELECT max(weeks.week_end)
    INTO v_last_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = (
     SELECT max(prior.season_year)
       FROM league_seasons AS prior
      WHERE prior.league_id = p_league_id
        AND prior.season_year < v_season_year
   );

  IF v_last_end IS NOT NULL AND v_today > v_last_end THEN
    v_elapsed_weeks := (v_today - v_last_end - 1) / 7;
    RETURN QUERY SELECT 1000 + v_elapsed_weeks,
      (v_last_end + 1 + (v_elapsed_weeks + 1) * 7)::timestamp AT TIME ZONE v_zone;
    RETURN;
  END IF;

  RETURN QUERY SELECT 1, NULL::timestamptz;
END;
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
  v_resets_at timestamptz;
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

  SELECT week.week_number, week.resets_at
    INTO v_week, v_resets_at
    FROM private.current_add_week(p_league_id, p_league_season_id) AS week;

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

  -- PA001 is the weekly add limit; the Edge API and the app classify on it.
  IF COALESCE(v_used, 0) >= v_limit THEN
    RAISE EXCEPTION '%', private.weekly_add_limit_message(COALESCE(v_used, 0), v_limit, v_resets_at)
      USING ERRCODE = 'PA001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM trade_items AS item
    JOIN roster_players AS roster
      ON roster.league_id = p_league_id
     AND roster.league_season_id = p_league_season_id
     AND roster.member_id = item.from_member_id
     AND roster.player_id = item.player_id
   WHERE item.trade_id = p_trade_id
     AND item.player_id IS NOT NULL
   ORDER BY roster.id
   FOR UPDATE OF roster;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.member_id = item.from_member_id
            AND roster.player_id = item.player_id
            AND roster.is_on_ir = false
            AND roster.is_on_taxi = false
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND private.is_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, item.player_id, NULL, p_trade_id)
  ) THEN
    RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
  END IF;

  PERFORM 1
    FROM trade_items AS item
    JOIN draft_picks AS pick
      ON pick.id = item.pick_id
     AND pick.league_id = p_league_id
     AND pick.current_owner_id = item.from_member_id
     AND pick.is_used = false
   WHERE item.trade_id = p_trade_id
     AND item.pick_id IS NOT NULL
   ORDER BY pick.id
   FOR UPDATE OF pick;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM draft_picks AS pick
          WHERE pick.id = item.pick_id
            AND pick.league_id = p_league_id
            AND pick.current_owner_id = item.from_member_id
            AND pick.is_used = false
       )
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND private.is_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, NULL, item.pick_id, p_trade_id)
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is reserved for another accepted trade';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_active_count int;
  v_waiver_log_id uuid;
  v_existing_roster_id uuid;
  v_ineligible text;
BEGIN
  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
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

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_player_id::text));

  SELECT string_agg(COALESCE(p.display_name, 'Unknown'), ', ')
    INTO v_ineligible
    FROM roster_players rp
    JOIN players p ON p.id = rp.player_id
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = v_season_id
     AND rp.is_on_ir = true
     AND NOT (
       lower(COALESCE(p.injury_status, '')) = 'out'
       OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
     );

  IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
    RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before adding players.',
      v_ineligible
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
    INTO v_waiver_log_id
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
     AND clears_at > now()
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF v_waiver_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
    INTO v_existing_roster_id
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
   FOR UPDATE;

  IF v_existing_roster_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is already on a roster.'
      USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Free-agent adds require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Free-agent adds require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    'fa_add'
  );

  PERFORM private.consume_weekly_add(p_league_id, v_season_id, p_member_id);

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'free_agent_added',
    'Free agent added',
    NULL,
    p_member_id,
    p_member_id,
    p_player_id,
    NULL,
    NULL,
    '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic(
  p_process_date date
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_projected_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
  v_lock_player_id uuid;
  v_target_league_id uuid;
  v_target_season_id uuid;
  v_target_player_id uuid;
  v_ineligible text;
  v_faab_balance int;
  v_player_name text;
  v_candidate record;
BEGIN
  FOR v_candidate IN
    WITH candidate_groups AS (
      SELECT
        candidate.league_id,
        candidate.league_season_id,
        candidate.player_id,
        min(candidate.process_date) AS process_date
        FROM waiver_claims AS candidate
        JOIN waiver_wire_log AS due_wwl
          ON due_wwl.league_id = candidate.league_id
         AND due_wwl.league_season_id = candidate.league_season_id
         AND due_wwl.player_id = candidate.player_id
         AND due_wwl.cleared_at IS NULL
         AND due_wwl.clears_at <= now()
        JOIN leagues AS claim_league
          ON claim_league.id = candidate.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = candidate.league_season_id
         AND claim_season.is_current = true
       WHERE candidate.status = 'pending'
         AND candidate.process_date <= p_process_date
       GROUP BY candidate.league_id, candidate.league_season_id, candidate.player_id
    ), league_candidates AS (
      SELECT DISTINCT ON (candidate_groups.league_id, candidate_groups.league_season_id)
        candidate_groups.*
        FROM candidate_groups
       ORDER BY candidate_groups.league_id, candidate_groups.league_season_id,
         candidate_groups.process_date, candidate_groups.player_id
    )
    SELECT league_candidates.league_id, league_candidates.league_season_id, league_candidates.player_id
      FROM league_candidates
     ORDER BY league_candidates.process_date, league_candidates.league_id,
       league_candidates.league_season_id, league_candidates.player_id
     LIMIT 128
  LOOP
    IF pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN
      v_target_league_id := v_candidate.league_id;
      v_target_season_id := v_candidate.league_season_id;
      v_target_player_id := v_candidate.player_id;
      EXIT;
    END IF;
  END LOOP;

  IF v_target_league_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1
    FROM waiver_priorities AS wp_lock
   WHERE wp_lock.league_id = v_target_league_id
     AND wp_lock.league_season_id = v_target_season_id
   ORDER BY wp_lock.priority
   FOR UPDATE;

  SELECT wc.*
    INTO v_claim
    FROM waiver_claims AS wc
    JOIN waiver_priorities AS wp
      ON wp.league_id = wc.league_id
     AND wp.league_season_id = wc.league_season_id
     AND wp.member_id = wc.member_id
    JOIN waiver_wire_log AS due_wwl
      ON due_wwl.league_id = wc.league_id
     AND due_wwl.league_season_id = wc.league_season_id
     AND due_wwl.player_id = wc.player_id
     AND due_wwl.cleared_at IS NULL
     AND due_wwl.clears_at <= now()
    JOIN leagues AS claim_league
      ON claim_league.id = wc.league_id
     AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
    JOIN league_seasons AS claim_season
      ON claim_season.id = wc.league_season_id
     AND claim_season.is_current = true
   WHERE wc.status = 'pending'
     AND wc.process_date <= p_process_date
     AND wc.league_id = v_target_league_id
     AND wc.league_season_id = v_target_season_id
     AND wc.player_id = v_target_player_id
   ORDER BY
     CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,
     wp.priority ASC,
     wc.claim_order ASC,
     wc.submitted_at ASC,
     wc.id ASC
   LIMIT 1
   FOR UPDATE OF wc;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.member_id::text));

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT wwl.id
    INTO v_waiver_log_id
    FROM waiver_wire_log AS wwl
   WHERE wwl.league_id = v_claim.league_id
     AND wwl.league_season_id = v_claim.league_season_id
     AND wwl.player_id = v_claim.player_id
     AND wwl.cleared_at IS NULL
     AND wwl.clears_at <= now()
   ORDER BY wwl.clears_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    v_failure := 'Player no longer on waivers.';
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_priority'::waiver_claim_status,
      v_failure
    );
    RETURN;
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

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waivers require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_claim.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waivers require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT display_name
    INTO v_player_name
    FROM players
   WHERE id = v_claim.player_id;

  IF v_league.weekly_add_limit IS NOT NULL THEN
    BEGIN
      PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
    EXCEPTION
      WHEN SQLSTATE 'PA001' THEN
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_roster'::waiver_claim_status,
          SQLERRM,
          'waiver_claim_failed_add_limit',
          'Waiver claim failed',
          jsonb_build_object('bid_amount', v_claim.bid_amount)
        );
        RETURN;
    END;
  END IF;

  IF v_league.waiver_mode = 'faab' THEN
    v_faab_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
    IF v_faab_balance < v_claim.bid_amount THEN
      v_failure := 'Insufficient FAAB budget for this bid.';
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_priority'::waiver_claim_status,
        v_failure,
        'faab_bid_failed',
        'FAAB bid failed',
        jsonb_build_object('bid_amount', v_claim.bid_amount)
      );
      RETURN;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM roster_players AS rp
     WHERE rp.league_id = v_claim.league_id
       AND rp.league_season_id = v_claim.league_season_id
       AND rp.player_id = v_claim.player_id
     FOR UPDATE
  ) THEN
    v_failure := 'Player already on a roster.';
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_priority'::waiver_claim_status,
      v_failure
    );
    RETURN;
  END IF;

  v_roster_size := v_league.roster_size;

  SELECT string_agg(COALESCE(p.display_name, 'Unknown'), ', ')
    INTO v_ineligible
    FROM roster_players AS rp
    JOIN players AS p ON p.id = rp.player_id
   WHERE rp.member_id = v_claim.member_id
     AND rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.is_on_ir = true
     AND NOT (
       lower(COALESCE(p.injury_status, '')) = 'out'
       OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
     );

  IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
    v_failure := format(
      'You have ineligible players on IR (%s). Activate or drop them before waiver claims can process.',
      v_ineligible
    );
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_roster'::waiver_claim_status,
      v_failure
    );
    RETURN;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players AS rp
   WHERE rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.member_id = v_claim.member_id
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false;

  v_projected_active_count := v_active_count + 1 - CASE WHEN v_claim.drop_player_id IS NULL THEN 0 ELSE 1 END;

  IF v_projected_active_count > COALESCE(v_roster_size, 20) THEN
    v_failure := CASE
      WHEN v_claim.drop_player_id IS NULL THEN 'Roster full and no drop player specified.'
      ELSE 'Waiver claim would leave your active roster over the limit.'
    END;
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_roster'::waiver_claim_status,
      v_failure
    );
    RETURN;
  END IF;

  IF v_claim.drop_player_id IS NOT NULL THEN
    SELECT validation.roster_player_id, validation.failure_reason
      INTO v_drop_roster_id, v_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.drop_player_id,
        'Drop player is no longer on this active roster.'
      ) AS validation;

    IF v_failure IS NOT NULL THEN
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        v_failure
      );
      RETURN;
    END IF;
  END IF;

  -- Mark the claim before the drop is released: the roster-lifecycle trigger
  -- clears stale drop selections on pending claims, and this claim's recorded
  -- drop must survive as history.
  UPDATE waiver_claims
     SET status = 'succeeded',
         processed_at = now(),
         failure_reason = NULL
   WHERE id = v_claim.id;

  IF v_drop_roster_id IS NOT NULL THEN
    PERFORM private.release_roster_player_to_waivers(
      v_drop_roster_id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.drop_player_id,
      'waiver_drop',
      v_claim.id
    );
  END IF;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    acquired_via
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver_add',
    v_claim.id
  );

  UPDATE waiver_wire_log
     SET cleared_at = now(),
         claimed_by_claim_id = v_claim.id
   WHERE id = v_waiver_log_id;

  IF v_league.waiver_mode = 'faab' THEN
    UPDATE faab_balances AS balance_row
       SET balance = balance_row.balance - v_claim.bid_amount,
           updated_at = now()
     WHERE balance_row.league_id = v_claim.league_id
       AND balance_row.league_season_id = v_claim.league_season_id
       AND balance_row.member_id = v_claim.member_id;
  END IF;

  PERFORM private.consume_weekly_add(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);

  SELECT max(wp.priority)
    INTO v_max_priority
    FROM waiver_priorities AS wp
   WHERE wp.league_id = v_claim.league_id
     AND wp.league_season_id = v_claim.league_season_id;

  UPDATE waiver_priorities AS priority_row
     SET priority = COALESCE(v_max_priority, 0) + 1
   WHERE priority_row.league_id = v_claim.league_id
     AND priority_row.league_season_id = v_claim.league_season_id
     AND priority_row.member_id = v_claim.member_id;

  PERFORM private.log_league_activity(
    v_claim.league_id,
    v_claim.league_season_id,
    CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_won' ELSE 'waiver_claim_succeeded' END,
    CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid won' ELSE 'Waiver claim succeeded' END,
    COALESCE(v_player_name, 'Player') || CASE
      WHEN v_league.waiver_mode = 'faab' THEN format(' won for $%s.', v_claim.bid_amount)
      ELSE ' added from waivers.'
    END,
    NULL,
    v_claim.member_id,
    v_claim.player_id,
    NULL,
    v_claim.id,
    jsonb_build_object('bid_amount', v_claim.bid_amount, 'waiver_mode', v_league.waiver_mode)
  );

  RETURN QUERY
    SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;

  RETURN QUERY
  WITH failed AS (
    UPDATE waiver_claims AS wc_other
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = CASE
             WHEN v_league.waiver_mode = 'faab' THEN 'Claimed by a higher FAAB bid or tiebreaker.'
             ELSE 'Claimed by higher-priority team.'
           END
     WHERE wc_other.status = 'pending'
       AND wc_other.league_id = v_claim.league_id
       AND wc_other.league_season_id = v_claim.league_season_id
       AND wc_other.player_id = v_claim.player_id
       AND wc_other.id <> v_claim.id
     RETURNING wc_other.id, wc_other.member_id, wc_other.player_id, wc_other.status, wc_other.failure_reason, wc_other.bid_amount
  ),
  logged AS (
    INSERT INTO league_activity (
      league_id,
      league_season_id,
      target_member_id,
      related_player_id,
      related_claim_id,
      event_type,
      title,
      body,
      metadata
    )
    SELECT
      v_claim.league_id,
      v_claim.league_season_id,
      failed.member_id,
      failed.player_id,
      failed.id,
      CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_lost' ELSE 'waiver_claim_failed_priority' END,
      CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid lost' ELSE 'Waiver claim failed' END,
      failed.failure_reason,
      jsonb_build_object('bid_amount', failed.bid_amount, 'winning_bid_amount', v_claim.bid_amount)
    FROM failed
    RETURNING id
  )
  SELECT true, failed.id, failed.member_id, failed.player_id, failed.status, failed.failure_reason
    FROM failed;
END;
$$;
