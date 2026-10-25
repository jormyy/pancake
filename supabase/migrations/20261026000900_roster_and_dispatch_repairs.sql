BEGIN;
DROP FUNCTION private.ineligible_ir_player_names(uuid,uuid,uuid);
CREATE OR REPLACE FUNCTION private.notif_league_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
  v_occurrence text := NEW.id::text || ':' || gen_random_uuid()::text;
  v_ignored text[] := ARRAY['id','created_at','updated_at','status','deleted_at','deleted_by','invite_code','slug','taxi_rule'];
BEGIN
  IF (to_jsonb(OLD) - v_ignored) IS NOT DISTINCT FROM (to_jsonb(NEW) - v_ignored) THEN RETURN NEW; END IF;
  FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.id LOOP
    PERFORM private.notif_enqueue('league_settings_changed',v_occurrence,NEW.id,m.id,jsonb_build_object('leagueId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION private.taxi_player_eligible(p_league_id uuid, p_player_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(player.years_exp = 0 OR player.career_regular_season_games < 65, false)
  FROM players player
  WHERE player.id = p_player_id;
$$;
CREATE OR REPLACE FUNCTION private.roster_problems(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS TABLE(kind text, roster_player_id uuid, player_name text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH roster AS (
    SELECT r.*, COALESCE(p.display_name, 'Unknown') AS player_name, p.injury_status,
      p.years_exp, p.career_regular_season_games,
      count(*) FILTER (WHERE NOT r.is_on_ir AND NOT r.is_on_taxi) OVER () AS active_count,
      COALESCE(l.roster_size,20) AS roster_size
    FROM public.roster_players r JOIN public.players p ON p.id=r.player_id
    JOIN public.leagues l ON l.id=r.league_id
    WHERE r.league_id=p_league_id AND r.league_season_id=p_league_season_id AND r.member_id=p_member_id
  )
  SELECT 'ir', id, player_name, player_name || ' is no longer eligible for IR. Activate or drop this player.'
  FROM roster WHERE is_on_ir AND NOT private.is_ir_designation(injury_status)
  UNION ALL
  SELECT 'taxi', id, player_name, player_name || ' is no longer taxi-eligible. Activate or drop this player.'
  FROM roster WHERE is_on_taxi AND career_regular_season_games IS NOT NULL
    AND NOT private.taxi_player_eligible(p_league_id,player_id)
  UNION ALL
  (SELECT 'active_limit', NULL::uuid, NULL::text,
    format('Your active roster is %s over the limit of %s. Drop or move an eligible player to IR.',active_count-roster_size,roster_size)
  FROM roster WHERE active_count>roster_size LIMIT 1);
$$;
CREATE OR REPLACE FUNCTION private.assert_roster_within_active_limit(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM 1
    FROM leagues
   WHERE id = p_league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM private.roster_problems(p_league_id,p_league_season_id,p_member_id)
    WHERE kind='active_limit') THEN
    RAISE EXCEPTION 'Roster is over the active player limit. Drop or move an eligible player to IR/taxi before editing your lineup.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION private.assert_taxi_acquisition_allowed(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = public, private AS $$
DECLARE v_slots int; v_count int; v_held int:=0;
BEGIN
  IF EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=p_member_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player has left your team''s taxi squad and cannot return to it, even after reacquisition or a season change.' USING ERRCODE='P0001';
  END IF;
  IF NOT private.taxi_player_eligible(p_league_id,p_player_id) THEN
    IF EXISTS (SELECT 1 FROM players WHERE id=p_player_id AND career_regular_season_games IS NULL) THEN
      RAISE EXCEPTION 'The career games count is not known yet. This player cannot enter taxi.' USING ERRCODE='P0001';
    END IF;
    RAISE EXCEPTION 'Taxi requires an NBA rookie or fewer than 65 career regular-season games.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM leagues league JOIN league_seasons season ON season.id=p_season_id
    WHERE league.id=p_league_id AND league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(p_league_id,p_player_id,season.season_year)>=league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'This player has reached the taxi tenure limit.' USING ERRCODE='P0001';
  END IF;
  IF private.roster_status_game_started(p_player_id) AND NOT EXISTS (
    SELECT 1 FROM private.taxi_acquisition_context c WHERE c.transaction_id=pg_current_xact_id()
      AND c.league_id=p_league_id AND c.league_season_id=p_season_id
      AND c.member_id=p_member_id AND c.player_id=p_player_id AND c.source IN ('free_agent','waiver')
  ) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.' USING ERRCODE='P0001';
  END IF;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=p_league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players
   WHERE league_id=p_league_id AND league_season_id=p_season_id AND member_id=p_member_id AND is_on_taxi;
  IF EXISTS (SELECT 1 FROM private.taxi_acquisition_context c
    WHERE c.transaction_id=pg_current_xact_id() AND c.league_id=p_league_id
      AND c.league_season_id=p_season_id AND c.member_id=p_member_id AND c.player_id=p_player_id
      AND c.source IN ('free_agent','waiver')) THEN
    SELECT count(*) INTO v_held FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
      WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND trade.status='accepted'
        AND item.to_member_id=p_member_id AND item.player_id IS NOT NULL AND item.to_taxi;
  END IF;
  IF v_count+v_held >= COALESCE(v_slots,0) AND v_held>0 THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots). Accepted trades hold % taxi slot(s).',COALESCE(v_slots,0),v_held USING ERRCODE='P0001';
  END IF;
  IF v_count >= COALESCE(v_slots,0) AND NOT EXISTS (SELECT 1 FROM private.taxi_acquisition_context c JOIN trades t ON t.id=c.related_id WHERE c.transaction_id=pg_current_xact_id() AND c.source='trade' AND c.player_id=p_player_id AND t.status='accepted' AND EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades)) THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots).', COALESCE(v_slots,0) USING ERRCODE='P0001';
  END IF;
END;
$$;
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
  v_taxi_count int;
  v_taxi_incoming int;
  v_taxi_held int;
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

  PERFORM private.assert_legal_roster(v_trade.league_id,v_trade.league_season_id,p_accepting_member_id);

  IF NOT v_league.allow_inactive_trades THEN
    SELECT count(*) INTO v_taxi_incoming FROM trade_items
      WHERE trade_id=p_trade_id AND to_member_id=p_accepting_member_id AND player_id IS NOT NULL AND to_taxi;
    IF v_taxi_incoming>0 THEN
      SELECT count(*) INTO v_taxi_count FROM roster_players WHERE league_id=v_trade.league_id
        AND league_season_id=v_trade.league_season_id AND member_id=p_accepting_member_id AND is_on_taxi;
      SELECT count(*) INTO v_taxi_held FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
        WHERE trade.id<>p_trade_id AND trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
          AND trade.status='accepted' AND item.to_member_id=p_accepting_member_id AND item.player_id IS NOT NULL AND item.to_taxi;
      IF v_taxi_count+v_taxi_incoming+v_taxi_held>COALESCE(v_league.taxi_slots,0) THEN
        RAISE EXCEPTION 'Your taxi squad is full (% slots). Accepted trades hold % taxi slot(s).',COALESCE(v_league.taxi_slots,0),v_taxi_held USING ERRCODE='P0001';
      END IF;
    END IF;
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
CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
  v_claim record;
  v_error text;
  v_run uuid;
BEGIN
  FOR v_row IN
    WITH batch AS MATERIALIZED (
      SELECT inv.*
        FROM public.edge_invocations AS inv
       WHERE inv.reconciled_at IS NULL AND inv.queued_at < now() - interval '1 minute'
       ORDER BY inv.queued_at LIMIT 500 FOR UPDATE OF inv SKIP LOCKED
    )
    SELECT batch.*, resp.status_code AS response_status, resp.error_msg, resp.timed_out,
           left(resp.content, 500) AS content
      FROM batch
      LEFT JOIN net._http_response AS resp
        ON resp.id = batch.request_id
       AND resp.created >= (SELECT min(queued_at) FROM batch) - interval '1 minute'
     ORDER BY batch.queued_at
  LOOP
    v_error := CASE
      WHEN v_row.error_msg IS NOT NULL THEN v_row.error_msg
      WHEN v_row.timed_out IS TRUE THEN 'timed out'
      WHEN v_row.response_status NOT BETWEEN 200 AND 299
        THEN 'HTTP ' || v_row.response_status || ': ' || COALESCE(v_row.content, '')
      ELSE NULL END;
    UPDATE public.edge_invocations
       SET status_code = v_row.response_status, error_message = v_error
     WHERE id = v_row.id
       AND (status_code, error_message) IS DISTINCT FROM (v_row.response_status, v_error);

    IF v_row.worker_started_at IS NOT NULL THEN
      IF v_row.worker_finished_at IS NULL THEN
        IF v_row.worker_started_at >= now() - interval '10 minutes' THEN CONTINUE; END IF;
        UPDATE public.sync_runs SET status = 'failed', finished_at = now(),
          error = 'worker did not finish within 10 minutes' WHERE id = v_row.sync_run_id;
        UPDATE public.edge_invocations SET worker_status = 'failed' WHERE id = v_row.id;
      END IF;
    ELSIF v_row.function_name='sync-player-injuries' AND v_row.response_status=404 THEN
      NULL;
    ELSIF v_row.response_status BETWEEN 200 AND 299 AND v_error IS NULL THEN
      NULL;
    ELSE
      IF v_row.invocation_key IS NOT NULL AND v_row.queued_at >= now() - interval '10 minutes' THEN
        CONTINUE;
      END IF;
      IF v_error IS NULL THEN
        IF v_row.invocation_key IS NULL AND v_row.queued_at >= now() - interval '2 hours' THEN CONTINUE; END IF;
        v_error := CASE WHEN v_row.invocation_key IS NULL THEN
          'no response recorded within 2 hours (request never sent or pg_net purged it)'
          ELSE 'no worker or response recorded within 10 minutes' END;
      END IF;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed', v_error)
      RETURNING id INTO v_run;
      UPDATE public.edge_invocations SET sync_run_id = v_run, error_message = v_error WHERE id = v_row.id;
    END IF;
    UPDATE public.edge_invocations SET reconciled_at = now() WHERE id = v_row.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  FOR v_claim IN
    SELECT * FROM public.cron_dispatch_state WHERE attempts < 3 FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
       AND reconciled_at IS NULL
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
         AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
         AND NOT (function_name='sync-player-injuries' AND status_code IS NOT DISTINCT FROM 404 AND worker_status IS NULL)
         AND (worker_status = 'failed' OR (worker_status IS NULL
           AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)))
      ) THEN
        UPDATE public.cron_dispatch_state SET retry_after = clock_timestamp() + interval '5 minutes'
         WHERE job_key = v_claim.job_key AND retry_after IS NULL;
      ELSE
        UPDATE public.cron_dispatch_state SET retry_after = NULL
         WHERE job_key = v_claim.job_key AND retry_after IS NOT NULL;
      END IF;
    END IF;
  END LOOP;
  RETURN v_reconciled;
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

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status NOT IN ('completed'::draft_status,'cancelled'::draft_status) THEN
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

  IF v_unfilled_picks > 0 AND v_draft.status<>'cancelled' THEN
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
CREATE OR REPLACE FUNCTION private.prevent_active_over_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'active'::league_status
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'drafting' AND EXISTS (
      SELECT 1 FROM league_seasons AS season
      JOIN drafts AS draft ON draft.league_season_id = season.id AND draft.league_id = NEW.id
      WHERE season.league_id = NEW.id AND season.is_current
        AND draft.draft_type = 'snake' AND draft.status IN ('completed','cancelled') AND NOT draft.is_mock
        AND private.draft_timer_opening_night_cutoff(season.season_year) <= now()
        AND (draft.status='cancelled' OR NOT EXISTS (SELECT 1 FROM snake_draft_picks AS pick WHERE pick.draft_id = draft.id
          AND pick.player_id IS NULL AND pick.skipped_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM drafts AS unfinished WHERE unfinished.league_season_id = season.id
          AND unfinished.draft_type = 'snake' AND NOT unfinished.is_mock
          AND unfinished.status IN ('pending', 'in_progress', 'paused'))
    ) THEN
      RETURN NEW;
    END IF;
    PERFORM 1
      FROM league_seasons AS season
      JOIN league_members AS member
        ON member.league_id = NEW.id
      LEFT JOIN roster_players AS roster
        ON roster.league_id = NEW.id
       AND roster.league_season_id = season.id
       AND roster.member_id = member.id
       AND roster.is_on_ir = false
       AND roster.is_on_taxi = false
     WHERE season.league_id = NEW.id
       AND season.is_current = true
     GROUP BY member.id
    HAVING count(roster.id) > NEW.roster_size
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'League cannot become active while a roster exceeds the active roster cap.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION private.lock_roster_activation(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_target roster_players%ROWTYPE;
  v_free roster_players%ROWTYPE;
  v_current roster_players%ROWTYPE;
  v_player_id uuid;
  v_rookie_draft_id uuid;
BEGIN
  IF p_activate_source IS NULL OR p_activate_source NOT IN ('ir', 'taxi') THEN
    RAISE EXCEPTION 'Invalid activation source.' USING ERRCODE = '22023';
  END IF;

  SELECT rp.* INTO v_target FROM roster_players AS rp
   JOIN league_members AS member ON member.id = rp.member_id
   WHERE rp.id = p_activate_roster_player_id AND member.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to activate this roster player.' USING ERRCODE = '42501';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
    SELECT * INTO v_free FROM roster_players
     WHERE id = p_free_roster_player_id
       AND league_id = v_target.league_id AND league_season_id = v_target.league_season_id
       AND member_id = v_target.member_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The freed player must belong to the same roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_target.league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_target.league_id::text), hashtext(v_target.member_id::text));
  FOR v_player_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[v_target.player_id, v_free.player_id]) AS id
     WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_target.league_id::text), hashtext(v_player_id::text));
  END LOOP;
  PERFORM 1 FROM roster_players WHERE id IN (p_activate_roster_player_id, p_free_roster_player_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_current FROM roster_players
   WHERE id = v_target.id AND league_id = v_target.league_id AND league_season_id = v_target.league_season_id
     AND member_id = v_target.member_id AND player_id = v_target.player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This roster changed. Refresh and try again.' USING ERRCODE = 'P0001';
  END IF;
  IF (p_activate_source = 'ir' AND NOT v_current.is_on_ir)
     OR (p_activate_source = 'taxi' AND NOT v_current.is_on_taxi) THEN
    RAISE EXCEPTION 'This player is no longer on %. Refresh your roster and try again.', upper(p_activate_source)
      USING ERRCODE = 'P0001';
  END IF;

  IF p_free_roster_player_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM roster_players WHERE id = v_free.id AND league_id = v_target.league_id
      AND league_season_id = v_target.league_season_id AND member_id = v_target.member_id
      AND player_id = v_free.player_id
  ) THEN
    RAISE EXCEPTION 'This roster changed. Refresh and try again.' USING ERRCODE = 'P0001';
  END IF;
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
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
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
CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid, p_expected_league_season_id uuid, p_rookie_draft_id uuid)
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
  v_rows int;
  v_rookie_draft_id uuid;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
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
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_league_season_id IS NOT NULL
     AND v_rp.league_season_id <> p_expected_league_season_id THEN
    RAISE EXCEPTION 'The roster season has changed. Refresh before dropping a player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
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

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_rookie_draft_id IS NOT NULL THEN
    IF p_expected_league_season_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM drafts
       WHERE id = p_rookie_draft_id
         AND league_id = v_rp.league_id
         AND league_season_id = v_rp.league_season_id
         AND draft_type = 'snake' AND NOT is_mock
         AND status IN ('in_progress', 'paused', 'completed', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'The draft has changed. Refresh before trimming the roster.' USING ERRCODE = 'P0001';
    END IF;
    IF v_rp.is_on_ir OR v_rp.is_on_taxi OR (
      SELECT count(*) FROM roster_players
       WHERE league_id = v_rp.league_id AND league_season_id = v_rp.league_season_id
         AND member_id = v_rp.member_id AND NOT is_on_ir AND NOT is_on_taxi
    ) <= v_league.roster_size THEN
      RAISE EXCEPTION 'The active roster no longer needs this drop. Refresh the roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id
  );

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
    'fa_drop'
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(p_roster_player_id uuid, p_to_taxi boolean, p_user_id uuid)
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
  v_roster_size int;
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
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
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
    AND NOT (v_league.status='offseason' AND p_to_taxi=false) THEN
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

  IF NOT p_to_taxi AND NOT v_rp.is_on_taxi THEN
    RETURN;
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);

  IF p_to_taxi THEN
    RAISE EXCEPTION 'Players enter taxi through a draft, trade, free-agent add or waiver claim.'
      USING ERRCODE = 'P0001';
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
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
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
    CASE WHEN p_to_taxi THEN 'taxi_designate' ELSE 'taxi_return' END
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid,
  p_to_ir boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
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
  v_ir_count int;
  v_injury text;
BEGIN
  IF p_to_ir AND p_to_taxi THEN
    RAISE EXCEPTION 'Choose IR or taxi, not both.' USING ERRCODE='P0001';
  END IF;
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

  PERFORM private.assert_legal_roster(p_league_id,v_season_id,p_member_id);

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

  PERFORM private.assert_free_agent_waiver_cleared(p_league_id, v_season_id, p_player_id);

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF p_to_ir THEN
    IF v_league.status = 'offseason'::league_status THEN
      RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT injury_status INTO v_injury FROM players WHERE id = p_player_id FOR SHARE;
    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'PA006';
    END IF;
    SELECT count(*) INTO v_ir_count FROM roster_players
     WHERE member_id = p_member_id AND league_season_id = v_season_id AND is_on_ir;
    IF v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN
      RAISE EXCEPTION 'Your IR slots are full (% slots).', COALESCE(v_league.ir_slots, 2)
        USING ERRCODE = 'PA007';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF NOT COALESCE(p_to_ir, false) AND NOT COALESCE(p_to_taxi, false) AND v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'PA003';
  END IF;

  IF p_to_taxi THEN
    PERFORM private.authorize_taxi_acquisition(p_league_id,v_season_id,p_member_id,p_player_id,'free_agent',p_player_id);
  END IF;

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via,
    is_on_ir,
    is_on_taxi
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent',
    COALESCE(p_to_ir, false),
    COALESCE(p_to_taxi, false)
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    acquired_to_taxi
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    'fa_add',
    COALESCE(p_to_taxi,false)
  );

  PERFORM private.consume_weekly_add(p_league_id, v_season_id, p_member_id);

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'free_agent_added',
    'Free agent added',
    CASE WHEN p_to_taxi THEN 'Player added to taxi.' ELSE NULL END,
    p_member_id,
    p_member_id,
    p_player_id,
    NULL,
    NULL,
    '{}'::jsonb
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.invoke_player_injuries_if_due(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_last_tipoff timestamptz;
BEGIN
  SELECT max(game_time) INTO v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF (p_now AT TIME ZONE 'America/New_York')::time < time '11:00' OR v_last_tipoff IS NULL OR p_now>v_last_tipoff THEN RETURN; END IF;
  IF private.claim_cron_dispatch('et:player-injuries',date_bin(interval '15 minutes',p_now,timestamptz '2000-01-01 00:00 UTC')::text) THEN
    PERFORM private.invoke_claimed_edge_function('et:player-injuries','sync-player-injuries','{}'::jsonb);
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.stop_draft_atomic(
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
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status NOT IN ('pending', 'in_progress', 'paused') THEN
    RAISE EXCEPTION 'Only a pending or active draft can be stopped.';
  END IF;

  UPDATE nominations
     SET status = 'no_bid',
         countdown_expires_at = NULL,
         closed_at = now()
   WHERE draft_id = p_draft_id
     AND status = 'open';

  UPDATE snake_draft_picks
     SET timer_expires_at = NULL
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  UPDATE drafts
     SET status = 'cancelled',
         completed_at = now(),
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  IF NOT v_draft.is_mock THEN
    UPDATE draft_picks pick SET is_used=true,used_at=now(),rookie_draft_id=p_draft_id
      FROM snake_draft_picks slot WHERE slot.draft_id=p_draft_id
        AND slot.player_id IS NULL AND slot.draft_pick_id=pick.id AND NOT pick.is_used;
    IF v_draft.draft_type='snake' THEN
      IF NOT EXISTS (SELECT 1 FROM roster_players roster JOIN leagues league ON league.id=roster.league_id
        WHERE roster.league_id=v_draft.league_id AND roster.league_season_id=v_draft.league_season_id
          AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
        GROUP BY roster.member_id,league.roster_size HAVING count(*)>league.roster_size) THEN
        PERFORM private.activate_rookie_draft_league_if_ready(p_draft_id);
      END IF;
    ELSE
      UPDATE leagues SET status='active' WHERE id=v_draft.league_id;
    END IF;
  END IF;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'stop',
    jsonb_build_object('previousStatus', v_draft.status, 'draftType', v_draft.draft_type, 'isMock', v_draft.is_mock)
  );
END;
$$;
COMMIT;
