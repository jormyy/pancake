BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DROP FUNCTION IF EXISTS private.assert_trade_assets_acceptance_ready(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS private.playoff_seed_rankings(uuid,uuid,integer);
DROP FUNCTION IF EXISTS public.clear_ineligible_taxi_players();
ALTER TABLE public.standings ALTER COLUMN waiver_priority SET DEFAULT 0;
DROP TRIGGER IF EXISTS score_revision_result ON public.standings;
CREATE TRIGGER score_revision_result AFTER INSERT OR UPDATE OR DELETE ON public.standings FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('result', 'league_season_id,week_number,member_id,wins,losses,ties,points_for,points_against,max_possible_points');
DELETE FROM public.league_change_hints WHERE topic='player_stats';
ALTER TABLE public.league_change_hints DROP CONSTRAINT league_change_hints_topic_check;
ALTER TABLE public.league_change_hints ADD CONSTRAINT league_change_hints_topic_check CHECK(topic IN ('lineup','roster','score','game','stat','inventory','resources'));
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='nba-process-trades';
CREATE OR REPLACE FUNCTION private.accept_trade_participant_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_all_accepted boolean;
  v_veto_window_hours int;
  v_item_faab_amount int;
  v_balance int;
BEGIN
  -- Read first, lock parties and players in the order every roster mutation
  -- uses, then lock the trade row: a drop that expires this offer holds the
  -- member and player locks while it updates the trade, so taking the trade
  -- row first would deadlock against it.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;


  PERFORM 1
    FROM trade_participants
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can accept this trade.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND member_id = p_accepting_member_id
       AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This participant has already accepted the trade.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_member_lock IN
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
     ORDER BY participant.member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    );
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  -- Accepted completion owns its trade row before team locks. A stale pending
  -- action must not wait on that row while holding its team locks.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status
     WHERE id = p_trade_id AND status = 'pending'::trade_status;
    RETURN jsonb_build_object(
      'expired', true,
      'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
      'allAccepted', false,
      'proposerMemberId', v_trade.proposer_member_id,
      'recipientMemberId', v_trade.recipient_member_id,
      'participantMemberIds', (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      )
    );
  END IF;


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

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.available_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member, p_trade_id);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.';
    END IF;
  END LOOP;

  PERFORM private.assert_trade_window(v_trade.league_id,
    ARRAY(SELECT pick_id FROM trade_items WHERE trade_id=p_trade_id AND pick_id IS NOT NULL));

  SELECT NOT EXISTS (SELECT 1 FROM trade_participants
    WHERE trade_id=p_trade_id AND member_id<>p_accepting_member_id AND accepted_at IS NULL)
    INTO v_all_accepted;

  PERFORM private.assert_trade_assets_acceptance_ready(
    p_trade_id,
    v_trade.league_id,
    v_trade.league_season_id,
    CASE WHEN v_all_accepted THEN NULL ELSE p_accepting_member_id END
  );

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NULL
       AND item.pick_id IS NULL
       AND COALESCE(item.faab_amount, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
  END IF;

  UPDATE trade_participants
     SET accepted_at = now()
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
     AND accepted_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record participant acceptance.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND accepted_at IS NULL
  )
    INTO v_all_accepted;

  IF v_all_accepted THEN
    v_veto_window_hours := CASE
      WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
      ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
    END;

    UPDATE trades
       SET status = 'accepted',
           accepted_at = now(),
           veto_window_expires_at = CASE
             WHEN v_veto_window_hours = 0 THEN now() - interval '1 microsecond'
             ELSE now() + make_interval(hours => v_veto_window_hours)
           END,
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
      BEGIN
        PERFORM public.complete_accepted_trade_atomic(p_trade_id);
      EXCEPTION WHEN SQLSTATE 'PT002' THEN
        -- A receiving player's game is in progress: the accepted trade settles on a later queue run.
        NULL;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'expired', false,
    'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
    'allAccepted', v_all_accepted,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.activate_rookie_draft_league_if_ready(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
  v_deadline boolean;
  v_member record;
  v_roster record;
  v_active int;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status <> 'completed'::draft_status THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_unfilled_picks > 0 THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.is_mock = false
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  v_deadline := COALESCE(private.draft_timer_opening_night_cutoff(v_current_season.season_year) <= now(), false);
  IF v_league.status = 'drafting' AND v_deadline THEN
    FOR v_member IN SELECT id FROM league_members WHERE league_id = v_draft.league_id ORDER BY id LOOP
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.league_id::text), hashtext(v_member.id::text)) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_active FROM roster_players
        WHERE league_season_id = v_current_season.id AND member_id = v_member.id
          AND NOT is_on_ir AND NOT is_on_taxi;
      FOR v_roster IN
        SELECT roster.id, roster.player_id FROM roster_players AS roster
          JOIN snake_draft_picks AS pick ON pick.draft_id = v_draft.id
            AND pick.member_id = roster.member_id AND pick.player_id = roster.player_id
          JOIN players AS player ON player.id = roster.player_id AND player.years_exp = 0
        WHERE roster.league_season_id = v_current_season.id AND roster.member_id = v_member.id
          AND NOT private.is_reserved_trade_asset(v_draft.league_id, v_current_season.id, v_member.id, roster.player_id)
          AND roster.acquired_via = 'draft' AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
        ORDER BY pick.overall_pick DESC, roster.id FOR UPDATE OF roster SKIP LOCKED
      LOOP
        EXIT WHEN v_active <= v_league.roster_size;
        IF private.can_acquire_draft_taxi(v_draft.league_id, v_current_season.id, v_member.id,
          v_roster.player_id, v_draft.id, v_roster.id) THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id, v_current_season.id,
            v_member.id, v_roster.player_id, 'draft', v_draft.id);
          UPDATE roster_players SET is_on_taxi = true WHERE id = v_roster.id;
          INSERT INTO roster_transactions(league_id, league_season_id, member_id, player_id, transaction_type)
          VALUES(v_draft.league_id, v_current_season.id, v_member.id, v_roster.player_id, 'taxi_designate');
          v_active := v_active - 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND AND NOT v_deadline THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_only_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM private.validate_trade_rosters(p_trade_id, p_only_member_id);
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
            AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, item.player_id, NULL, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.player_id IS NOT NULL;

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

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, NULL, item.pick_id, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.pick_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.create_multi_team_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
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
  v_league leagues%ROWTYPE;
  v_rows int;
  v_participant_count int;
  v_first_recipient_member_id uuid;
  v_balance int;
  v_faab record;
  v_champion_finalized boolean := false;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Multi-team trade items must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'A multi-team trade must include between 1 and 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)
    INTO v_participant_count
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids);
  IF v_participant_count < 3 THEN
    RAISE EXCEPTION 'A multi-team trade requires at least 3 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF v_participant_count > 12 THEN
    RAISE EXCEPTION 'A multi-team trade cannot include more than 12 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE from_member_id = to_member_id
        OR faab_amount < 0
        OR ((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) <> 1
  ) THEN
    RAISE EXCEPTION 'Each multi-team trade item must route exactly one player, pick, or positive FAAB amount between two different teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items) AS item
     WHERE NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.from_member_id
     )
        OR NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.to_member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every item source and destination must be a trade participant.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
     WHERE NOT EXISTS (
       SELECT 1
         FROM private.parse_multi_team_trade_items(p_items) AS item
        WHERE item.from_member_id = participant.member_id
           OR item.to_member_id = participant.member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every participating team must send or receive at least one asset.'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) <>
     (SELECT count(DISTINCT player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded players are not allowed.';
  END IF;

  IF (SELECT count(pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) <>
     (SELECT count(DISTINCT pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded picks are not allowed.';
  END IF;

  PERFORM private.lock_trade_offer_assets(
    p_league_id,
    ARRAY(SELECT member_id FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)),
    ARRAY(SELECT player_id FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL)
  );

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

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

  PERFORM private.assert_trade_window(p_league_id, ARRAY(SELECT pick_id FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL));

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

  IF EXISTS (SELECT 1 FROM private.parse_multi_team_trade_items(p_items) WHERE faab_amount > 0)
     AND v_league.waiver_mode <> 'faab' THEN
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

  SELECT count(*)
    INTO v_rows
    FROM league_members AS member
    JOIN private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
      ON participant.member_id = member.id
   WHERE member.league_id = p_league_id;

  IF v_rows <> v_participant_count THEN
    RAISE EXCEPTION 'Every trade participant must be a member of this league.';
  END IF;

  WITH locked AS (
    SELECT item.player_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN roster_players AS roster
        ON roster.league_id = p_league_id
       AND roster.league_season_id = p_league_season_id
       AND roster.member_id = item.from_member_id
       AND roster.player_id = item.player_id
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
     WHERE item.player_id IS NOT NULL
     FOR SHARE OF roster
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A player asset is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT item.pick_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN draft_picks AS pick
        ON pick.id = item.pick_id
       AND pick.league_id = p_league_id
       AND pick.current_owner_id = item.from_member_id
       AND pick.is_used = false
     WHERE item.pick_id IS NOT NULL
     FOR SHARE OF pick
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A draft pick asset is no longer owned by the expected team.';
  END IF;

  FOR v_faab IN
    SELECT from_member_id, sum(faab_amount)::int AS amount
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE faab_amount > 0
     GROUP BY from_member_id
  LOOP
    v_balance := private.available_faab_balance(p_league_id, p_league_season_id, v_faab.from_member_id);
    IF v_balance < v_faab.amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds a participant''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT member_id
    INTO v_first_recipient_member_id
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
   WHERE member_id <> p_proposer_member_id
   ORDER BY sort_order, member_id
   LIMIT 1;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    is_multi_team,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    true,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    p_version
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_participants (
    trade_id,
    member_id,
    sort_order,
    is_initiator,
    accepted_at
  )
  SELECT
    v_trade_id,
    member_id,
    sort_order,
    member_id = p_proposer_member_id,
    CASE WHEN member_id = p_proposer_member_id THEN now() ELSE NULL END
  FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
  ORDER BY sort_order, member_id;

  INSERT INTO trade_items (
    trade_id,
    side,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  )
  SELECT
    v_trade_id,
    CASE WHEN from_member_id = p_proposer_member_id THEN 'proposer'::trade_side ELSE 'recipient'::trade_side END,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  FROM private.parse_multi_team_trade_items(p_items)
  ORDER BY sort_order;

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    'trade_offered',
    'Multi-team trade offer sent',
    NULL,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'is_multi_team', true,
      'participant_count', v_participant_count,
      'item_count', jsonb_array_length(p_items)
    )
  );

  RETURN v_trade_id;
END;
$$;

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
  v_balance int;
  v_champion_finalized boolean := false;
BEGIN
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

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

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

  IF v_offer_faab_amount > 0 THEN
    v_balance := private.available_faab_balance(p_league_id, p_league_season_id, p_proposer_member_id);
    IF v_balance < v_offer_faab_amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds the proposer''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_request_faab_amount > 0 THEN
    v_balance := private.available_faab_balance(p_league_id, p_league_season_id, p_recipient_member_id);
    IF v_balance < v_request_faab_amount THEN
      RAISE EXCEPTION 'Requested FAAB exceeds the recipient''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
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
END;
$$;

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
    WHEN 'league_activity' THEN
      RETURN NULL;
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

CREATE OR REPLACE FUNCTION private.enforce_trade_lifecycle_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_status league_status;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('accepted'::trade_status, 'completed'::trade_status) THEN
    SELECT status
      INTO v_status
      FROM leagues
     WHERE id = NEW.league_id
     FOR SHARE;

    IF v_status IS NULL THEN
      RAISE EXCEPTION 'League not found.'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status, 'drafting'::league_status) THEN
      RAISE EXCEPTION 'Trades open during offseason, drafting, active, and playoff seasons.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.flush_player_stats_hints()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH ready AS MATERIALIZED (
    SELECT pending.league_id FROM private.player_stats_hint_pending pending
    WHERE NOT EXISTS(SELECT 1 FROM public.league_change_hints hint
      WHERE hint.league_id=pending.league_id AND hint.topic='score'
        AND hint.updated_at>clock_timestamp()-interval '1 minute')
    ORDER BY pending.league_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), emitted AS (
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details,updated_at)
    SELECT ready.league_id,'score',1,NULL,NULL,clock_timestamp() FROM ready
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=NULL,updated_at=clock_timestamp()
    WHERE stored.updated_at<=clock_timestamp()-interval '1 minute'
    RETURNING league_id
  ) DELETE FROM private.player_stats_hint_pending WHERE league_id IN (SELECT league_id FROM emitted);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_enqueue(p_event text, p_occurrence text, p_league_id uuid, p_member_id uuid, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT p_event || ':' || p_occurrence || ':' || member.id,member.id,p_event,event.label,
    COALESCE(p_data->>'body',event.label || '. Open Pancake for details.'),
    p_data || jsonb_build_object('leagueId',p_league_id,'notificationEvent',p_event),event.category
  FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NULL CROSS JOIN public.notif_event_catalog event
  WHERE member.id = p_member_id AND member.league_id = p_league_id AND event.event_type = p_event
  ON CONFLICT (dedupe_key) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION private.playoff_clinched_standings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  season record;
  clincher record;
  team_count int;
  entrants int;
BEGIN
  FOR season IN
    SELECT DISTINCT s.id, s.league_id, s.season_year, s.skipped_weeks,
      l.playoff_start_week, l.playoff_entrants
    FROM clinch_standings changed
    JOIN public.league_seasons s ON s.id = changed.league_season_id AND s.league_id = changed.league_id
    JOIN public.leagues l ON l.id = s.league_id
    WHERE s.is_current AND l.status = 'active'
      AND changed.week_number < l.playoff_start_week
      AND NOT (changed.week_number = ANY(s.skipped_weeks))
  LOOP
    SELECT count(*) INTO team_count FROM public.league_members WHERE league_id = season.league_id;
    entrants := COALESCE(season.playoff_entrants, CASE WHEN team_count >= 10 THEN 6 ELSE 4 END);
    IF entrants < 2 OR entrants > team_count THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM generate_series(1, season.playoff_start_week - 1) expected(week_number)
      LEFT JOIN public.season_weeks w ON w.season_year = season.season_year AND w.week_number = expected.week_number
      WHERE NOT (expected.week_number = ANY(season.skipped_weeks)) AND w.id IS NULL
    ) THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT w.week_number
      FROM public.season_weeks w
      LEFT JOIN public.matchups m ON m.league_season_id = season.id AND m.week_number = w.week_number
        AND m.matchup_type = 'regular_season'
      WHERE w.season_year = season.season_year AND w.week_number < season.playoff_start_week
        AND NOT (w.week_number = ANY(season.skipped_weeks))
      GROUP BY w.week_number HAVING count(m.id) <> team_count / 2
    ) THEN CONTINUE; END IF;
    FOR clincher IN
      WITH bounds AS MATERIALIZED (
        SELECT ranking.*,
          count(matchup.id) FILTER (WHERE NOT matchup.is_finalized) AS remaining
        FROM private.playoff_seed_rankings(season.league_id, season.id, season.playoff_start_week) ranking
        LEFT JOIN public.matchups matchup ON matchup.league_season_id = season.id
          AND matchup.matchup_type = 'regular_season'
          AND matchup.week_number < season.playoff_start_week
          AND NOT (matchup.week_number = ANY(season.skipped_weeks))
          AND NOT matchup.is_voided
          AND ranking.member_id IN (matchup.home_member_id, matchup.away_member_id)
        GROUP BY ranking.member_id, ranking.wins, ranking.ties, ranking.games_played, ranking.points_for, ranking.max_possible_points,
          ranking.points_against, ranking.tie_token, ranking.seed_rank, ranking.group_start
      )
      SELECT candidate.member_id FROM bounds candidate
      WHERE CASE WHEN NOT EXISTS (SELECT 1 FROM bounds WHERE remaining > 0)
        THEN candidate.seed_rank <= entrants
        ELSE (SELECT count(*) FROM bounds opponent WHERE opponent.member_id <> candidate.member_id
          AND (opponent.wins + 0.5 * opponent.ties + opponent.remaining) / greatest(opponent.games_played + opponent.remaining, 1)
            >= (candidate.wins + 0.5 * candidate.ties) / greatest(candidate.games_played + candidate.remaining, 1)) < entrants
        END
    LOOP
      PERFORM private.notif_enqueue('playoff_clinched', season.id::text, season.league_id, clincher.member_id,
        jsonb_build_object('leagueSeasonId', season.id, 'seasonYear', season.season_year,
          'playoffEntrants', entrants, 'phase', 'qualification', 'body', 'Your team has clinched a playoff spot.'));
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.playoff_seed_rankings(
  p_league_id uuid,
  p_league_season_id uuid,
  p_playoff_start_week int
)
RETURNS TABLE (
  member_id uuid,
  wins bigint,
  ties bigint,
  games_played bigint,
  points_for numeric,
  max_possible_points numeric,
  points_against numeric,
  tie_token text,
  seed_rank bigint,
  group_start bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH member_stats AS (
    SELECT
      member.id AS member_id,
      count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
      count(matchup.id) AS games_played,
      count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NULL) AS ties,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_points
        ELSE 0
      END), 0) AS points_for,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
        ELSE 0
      END), 0) AS max_possible_points,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.away_points
        WHEN matchup.away_member_id = member.id THEN matchup.home_points
        ELSE 0
      END), 0) AS points_against,
      encode(extensions.digest((p_league_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
    FROM public.league_members AS member
    LEFT JOIN public.matchups AS matchup
      ON matchup.league_season_id = p_league_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < p_playoff_start_week
     AND matchup.is_finalized = true AND NOT matchup.is_voided
     AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    WHERE member.league_id = p_league_id
    GROUP BY member.id
  ),
  ranked AS (
    SELECT
      member_stats.*,
      row_number() OVER (
        ORDER BY (wins + 0.5 * ties) / greatest(games_played, 1) DESC,
          points_for / greatest(games_played, 1) DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC
      ) AS seed_rank
    FROM member_stats
  )
  SELECT
    member_id, wins, ties, games_played, points_for, max_possible_points, points_against, tie_token, seed_rank,
    min(seed_rank) OVER (
      PARTITION BY (wins + 0.5 * ties) / greatest(games_played, 1),
        points_for / greatest(games_played, 1), max_possible_points, points_against
    ) AS group_start
  FROM ranked;
$$;

CREATE OR REPLACE FUNCTION private.rebuild_regular_standings(p_league_id uuid, p_season_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO standings(league_id, league_season_id, member_id, week_number, wins, losses, ties,
    points_for, points_against, max_possible_points)
  SELECT p_league_id, p_season_id, member.id, weeks.week_number,
    count(result.id) FILTER (WHERE result.winner_member_id = member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NOT NULL AND result.winner_member_id <> member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_points ELSE result.away_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.away_points ELSE result.home_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_max_possible_points ELSE result.away_max_possible_points END), 0)
  FROM league_members member
  CROSS JOIN (SELECT DISTINCT matchup.week_number FROM matchups matchup WHERE matchup.league_season_id = p_season_id
    AND matchup.matchup_type = 'regular_season' AND ((matchup.is_finalized AND NOT matchup.is_voided)
      OR EXISTS (SELECT 1 FROM standings saved WHERE saved.league_season_id = p_season_id
        AND saved.week_number = matchup.week_number))) weeks
  LEFT JOIN matchups result ON result.league_season_id = p_season_id AND result.matchup_type = 'regular_season'
    AND result.week_number <= weeks.week_number AND result.is_finalized AND NOT result.is_voided
    AND member.id IN (result.home_member_id, result.away_member_id)
  WHERE member.league_id = p_league_id
  GROUP BY member.id, weeks.week_number
  ON CONFLICT (league_id, league_season_id, member_id, week_number) DO UPDATE SET
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for,
    points_against = EXCLUDED.points_against,
    max_possible_points = EXCLUDED.max_possible_points
  WHERE (standings.wins, standings.losses, standings.ties, standings.points_for, standings.points_against,
    standings.max_possible_points) IS DISTINCT FROM
    (EXCLUDED.wins, EXCLUDED.losses, EXCLUDED.ties, EXCLUDED.points_for, EXCLUDED.points_against,
      EXCLUDED.max_possible_points);
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
    max_possible_points
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
    standing.max_possible_points
  FROM jsonb_to_recordset(p_standings) AS standing(
    member_id uuid,
    created_at timestamptz,
    wins int,
    losses int,
    ties int,
    points_for numeric,
    points_against numeric,
    max_possible_points numeric
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

CREATE OR REPLACE FUNCTION public.notif_admit_delivery_atomic(p_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.notification_outbox%ROWTYPE;
  reason text;
  deferred_until timestamptz;
BEGIN
  SELECT * INTO r FROM public.notification_outbox WHERE id = p_id AND claim_token = p_claim_token FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.notification_outbox WHERE id = p_id AND suppressed_at IS NOT NULL) THEN RETURN false; END IF;
    RAISE EXCEPTION 'Notification delivery lease lost';
  END IF;
  IF r.delivered_at IS NOT NULL OR r.dead_lettered_at IS NOT NULL OR r.suppressed_at IS NOT NULL OR r.expo_ticket_id IS NOT NULL THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
    WHERE member.id=r.member_id AND league.deleted_at IS NOT NULL) THEN
    reason := 'league_deleted';
  ELSIF private.notif_is_stale(r.event_type,r.data) THEN
    reason := 'stale';
  ELSE
    deferred_until := private.notif_draft_deferred_until(r.event_type,r.data);
    IF deferred_until IS NOT NULL THEN
      UPDATE public.notification_outbox SET available_at=CASE WHEN deferred_until='infinity'::timestamptz THEN clock_timestamp() ELSE deferred_until END,claimed_at=NULL,claim_token=NULL WHERE id=r.id;
      RETURN false;
    END IF;
    IF NOT private.notif_preference_enabled((SELECT user_id FROM public.league_members WHERE id = r.member_id),r.event_type,r.category) THEN
      reason := 'preferences_disabled';
    END IF;
  END IF;
  IF reason IS NOT NULL THEN
    UPDATE public.notification_outbox SET suppressed_at = clock_timestamp(), suppression_reason = reason,
      claimed_at = NULL, claim_token = NULL WHERE id = r.id;
    RETURN false;
  END IF;
  UPDATE public.notification_outbox SET admitted_at=COALESCE(admitted_at,clock_timestamp()) WHERE id=r.id;
  RETURN true;
END;
$$;

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
  -- A batch retains league rows after each completion. Take every selected
  -- team's and player's locks before the first completion takes those rows.
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
    SELECT DISTINCT trade.league_id, member.member_id
      FROM public.trades AS trade
      CROSS JOIN LATERAL (
        SELECT trade.proposer_member_id AS member_id
        UNION SELECT trade.recipient_member_id
        UNION SELECT participant.member_id FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
      ) AS member
     WHERE trade.id = ANY(v_trade_ids)
     ORDER BY trade.league_id, member.member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.member_id::text));
  END LOOP;

  FOR v_asset IN
    SELECT DISTINCT trade.league_id, item.player_id
      FROM public.trades AS trade
      JOIN public.trade_items AS item ON item.trade_id = trade.id
     WHERE trade.id = ANY(v_trade_ids) AND item.player_id IS NOT NULL
     ORDER BY trade.league_id, item.player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.player_id::text));
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
        CASE
          WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
          ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
        END,
        'completed'::text,
        NULL::text,
        NULL::text;
    EXCEPTION
      WHEN SQLSTATE 'PT001' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        PERFORM public.expire_trade_completion_failure_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'expired_terminal_failure'::text,
          v_error_code,
          v_error_message;
      WHEN SQLSTATE 'PT002' THEN
        -- Deferred, not failed: the trade stays accepted and settles once the game slate ends.
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
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
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
    END;
  END LOOP;
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
    DELETE FROM public.rps_challenges WHERE league_season_id=p_league_season_id AND context='standings_playoff_tiebreaker';
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

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[]
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_member uuid; v_player uuid; v_all uuid[];
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_participants participant JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id AND member.id = p_member_id AND member.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leagues WHERE id = v_trade.league_id AND allow_inactive_trades) THEN
    RAISE EXCEPTION 'Enable IR and taxi trades in league settings first.';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids;
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  FOR v_member IN SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member::text));
  END LOOP;
  FOR v_player IN SELECT DISTINCT id FROM (
    SELECT unnest(v_all) id UNION SELECT player_id FROM trade_items WHERE trade_id = p_trade_id
  ) ids WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id AND status='pending' FOR UPDATE;
  IF NOT FOUND OR v_trade.status <> 'pending' OR v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids || p_ir_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Placements must belong to incoming players.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_drop_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND member_id = p_member_id AND player_id = choice.player_id)
    OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Drop choices must be your rostered players outside this offer.';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id AND player_id=ANY(p_ir_player_ids) AND is_on_taxi) THEN
    RAISE EXCEPTION 'Traded taxi players must remain on taxi with their original tenure.' USING ERRCODE='22023';
  END IF;
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_window(p_league_id uuid, p_pick_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_status public.league_status;
BEGIN
  SELECT status INTO v_status FROM public.leagues WHERE id=p_league_id FOR UPDATE;
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
    SELECT 1 FROM public.drafts draft
    JOIN public.league_seasons season ON season.id=draft.league_season_id AND season.is_current
    JOIN public.snake_draft_picks slot ON slot.draft_id=draft.id
    WHERE draft.league_id=p_league_id AND NOT draft.is_mock
      AND draft.status IN ('in_progress','paused')
      AND slot.draft_pick_id=ANY(p_pick_ids) AND slot.player_id IS NULL AND slot.skipped_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Picks in the live draft can be traded after the draft.' USING ERRCODE='P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_trade_assets_acceptance_ready(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.assert_trade_window(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.playoff_seed_rankings(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
