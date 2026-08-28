-- One owner each for the waiver add rule, the add-limit sentence, and pick cleanup.
--
-- add_free_agent_atomic no longer reads the waiver wire: the uncleared-entry
-- guard (prevent_uncleared_waiver_free_agent_add) is the rule's only owner.
-- private.weekly_add_limit_reset_label renders the reset boundary once; the
-- rejection sentence and get_member_transaction_state (new add_limit_message
-- and add_limit_resets_label columns, add_week_timezone removed) both use it,
-- so the app shows the server's own sentence before and after a request.
-- sync_trade_block_on_pick_change is renamed sync_pick_linked_state, matching
-- what it does. expire_pending_trades_for_lost_asset drops a guard both callers
-- already satisfy. Future lineup slots whose player already left the roster
-- are backfilled the way the roster trigger clears them.


DROP TRIGGER IF EXISTS sync_trade_block_on_pick_change ON public.draft_picks;
DROP FUNCTION IF EXISTS private.sync_trade_block_on_pick_change();

CREATE OR REPLACE FUNCTION private.sync_pick_linked_state()
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

REVOKE ALL ON FUNCTION private.sync_pick_linked_state() FROM PUBLIC;

CREATE TRIGGER sync_pick_linked_state
AFTER UPDATE OF current_owner_id, is_used ON public.draft_picks
FOR EACH ROW
EXECUTE FUNCTION private.sync_pick_linked_state();

CREATE OR REPLACE FUNCTION private.weekly_add_limit_reset_label(p_resets_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  -- "Mon, Nov 2 at 12:00 AM ET": the one rendering of the reset boundary, shown by
  -- the rejection message and by every client surface.
  SELECT CASE
           WHEN p_resets_at IS NULL THEN NULL
           ELSE to_char(p_resets_at AT TIME ZONE private.add_week_timezone(), 'Dy, Mon FMDD "at" FMHH12:MI AM') || ' ET'
         END;
$$;

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int,
  p_resets_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT format('Weekly add limit reached (%s/%s adds used this week).', p_used, p_limit)
    || COALESCE(format(' Adds reset %s.', private.weekly_add_limit_reset_label(p_resets_at)), '');
$$;

DROP FUNCTION IF EXISTS public.get_member_transaction_state(uuid, uuid);

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
  faab_balance int,
  add_limit_resets_at timestamptz,
  add_limit_message text,
  add_limit_resets_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_resets_at timestamptz;
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

  SELECT week.week_number, week.resets_at
    INTO v_week, v_resets_at
    FROM private.current_add_week(p_league_id, v_season_id) AS week;
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
    v_balance,
    v_resets_at,
    CASE WHEN league.weekly_add_limit IS NOT NULL AND count_row.add_count >= league.weekly_add_limit
         THEN private.weekly_add_limit_message(count_row.add_count, league.weekly_add_limit, v_resets_at)
    END,
    private.weekly_add_limit_reset_label(v_resets_at)
  FROM leagues AS league
  JOIN weekly_add_counts AS count_row
    ON count_row.league_id = league.id
   AND count_row.league_season_id = v_season_id
   AND count_row.member_id = p_member_id
   AND count_row.week_number = v_week
  WHERE league.id = p_league_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_member_transaction_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_member_transaction_state(uuid, uuid) TO authenticated, service_role;

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
      USING ERRCODE = 'PA003';
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

CREATE OR REPLACE FUNCTION private.expire_pending_trades_for_lost_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_pick_consumed boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text;
  v_previous_flag text;
BEGIN
  IF p_player_id IS NOT NULL THEN
    SELECT format('%s is no longer on %s.', player.display_name, COALESCE(member.team_name, 'the offering team'))
      INTO v_reason
      FROM players AS player, league_members AS member
     WHERE player.id = p_player_id
       AND member.id = p_member_id;
  ELSE
    SELECT format(
             CASE
               WHEN p_pick_consumed THEN 'The %s round %s pick has been used in the draft.'
               ELSE 'The %s round %s pick is no longer owned by %s.'
             END,
             pick.season_year,
             pick.round,
             COALESCE(member.team_name, 'the offering team')
           )
      INTO v_reason
      FROM draft_picks AS pick, league_members AS member
     WHERE pick.id = p_pick_id
       AND member.id = p_member_id;
  END IF;

  -- This may run inside an authenticated user's transaction (a drop expiring
  -- an offer); the status guard trusts server-owned lifecycle work.
  v_previous_flag := private.begin_trade_lifecycle_write();

  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status,
           completion_failure_reason = v_reason
     WHERE trade.league_id = p_league_id
       AND trade.status = 'pending'::trade_status
       AND EXISTS (
         SELECT 1
           FROM trade_items AS item
          WHERE item.trade_id = trade.id
            AND item.from_member_id = p_member_id
            AND (
              (p_player_id IS NOT NULL AND item.player_id = p_player_id)
              OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
            )
       )
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  )
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    event_type,
    title,
    body
  )
  SELECT
    expired.league_id,
    expired.league_season_id,
    expired.proposer_member_id,
    expired.recipient_member_id,
    p_player_id,
    expired.id,
    'trade_expired',
    'Trade offer expired',
    v_reason
    FROM expired;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
END;
$$;

-- Backfill: future unlocked lineup slots whose player is no longer active on
-- that member's roster, cleared the way sync_roster_linked_state clears them.
DO $$
DECLARE stale record;
BEGIN
  FOR stale IN
    SELECT DISTINCT lineup.league_id, lineup.league_season_id, lineup.member_id, lineup.player_id
      FROM public.weekly_lineups AS lineup
     WHERE lineup.game_date >= (now() AT TIME ZONE 'America/New_York')::date
       AND NOT EXISTS (
         SELECT 1 FROM public.roster_players AS roster
          WHERE roster.league_id = lineup.league_id
            AND roster.league_season_id = lineup.league_season_id
            AND roster.member_id = lineup.member_id
            AND roster.player_id = lineup.player_id
            AND roster.is_on_ir = false
            AND roster.is_on_taxi = false)
  LOOP
    PERFORM private.clear_future_unlocked_lineups(stale.league_id, stale.league_season_id, stale.player_id, stale.member_id);
  END LOOP;
END $$;
