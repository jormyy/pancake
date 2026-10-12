BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- NULL means a legacy acquisition has no unambiguous destination evidence.
ALTER TABLE public.roster_transactions ADD COLUMN acquired_to_taxi boolean;
ALTER TABLE public.roster_transactions ALTER COLUMN acquired_to_taxi SET DEFAULT false;
COMMENT ON COLUMN public.roster_transactions.acquired_to_taxi IS
  'Acquisition-time taxi destination. NULL preserves unknown legacy history; later activation has its own transaction.';

DROP TRIGGER score_revision_season ON public.roster_transactions;
CREATE TRIGGER score_revision_season AFTER INSERT OR UPDATE OR DELETE ON public.roster_transactions
FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision(
  'season', 'id,league_season_id,member_id,player_id,transaction_type,occurred_at,acquired_to_taxi');

-- Ordinary adds enter the active roster. Carry-over already records its reserve state separately.
UPDATE public.roster_transactions SET acquired_to_taxi = false
WHERE transaction_type NOT IN ('draft_won', 'trade_in');

-- A merge may repoint several source assets to one player. Never select one mixed match by chance.
WITH evidence AS (
  SELECT tx.id, item.to_taxi
  FROM public.roster_transactions tx
  JOIN public.trades trade ON trade.id = tx.related_trade_id
    AND trade.league_id = tx.league_id AND trade.league_season_id = tx.league_season_id
    AND trade.status = 'completed'
  JOIN public.trade_items item ON item.trade_id = trade.id
    AND item.player_id = tx.player_id AND item.to_member_id = tx.member_id
  WHERE tx.transaction_type = 'trade_in'
), certain AS (
  SELECT id, bool_and(to_taxi) AS to_taxi FROM evidence GROUP BY id
  HAVING bool_and(to_taxi) = bool_or(to_taxi)
)
UPDATE public.roster_transactions tx SET acquired_to_taxi = certain.to_taxi
FROM certain WHERE tx.id = certain.id;

WITH evidence AS (
  SELECT tx.id, nomination.current_bid_to_taxi AS to_taxi
  FROM public.roster_transactions tx
  JOIN public.nominations nomination ON nomination.id = tx.related_nomination_id
    AND nomination.player_id = tx.player_id AND nomination.winning_member_id = tx.member_id
    AND nomination.status = 'sold'
  JOIN public.drafts draft ON draft.id = nomination.draft_id
    AND draft.league_id = tx.league_id AND draft.league_season_id = tx.league_season_id
    AND NOT draft.is_mock
  WHERE tx.transaction_type = 'draft_won'
  UNION ALL
  SELECT tx.id, pick.to_taxi
  FROM public.roster_transactions tx
  JOIN public.snake_draft_picks pick ON pick.player_id = tx.player_id
    AND pick.member_id = tx.member_id AND pick.picked_at = tx.occurred_at
  JOIN public.drafts draft ON draft.id = pick.draft_id
    AND draft.league_id = tx.league_id AND draft.league_season_id = tx.league_season_id
    AND NOT draft.is_mock
  WHERE tx.transaction_type = 'draft_won' AND tx.related_nomination_id IS NULL
), certain AS (
  SELECT id, bool_and(to_taxi) AS to_taxi FROM evidence GROUP BY id
  HAVING bool_and(to_taxi) = bool_or(to_taxi)
)
UPDATE public.roster_transactions tx SET acquired_to_taxi = certain.to_taxi
FROM certain WHERE tx.id = certain.id;

-- Unknown destinations must also invalidate old certificates, without replacing their saved results.
SELECT private.bump_score_input_revisions(array_agg(DISTINCT 'season:' || league_season_id::text))
FROM public.roster_transactions WHERE transaction_type IN ('draft_won', 'trade_in');

CREATE OR REPLACE FUNCTION private.make_snake_pick_atomic_internal(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_allow_expired_timer boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_next_pick snake_draft_picks%ROWTYPE;
  v_on_roster_id uuid;
  v_already_picked_id uuid;
  v_now timestamptz := now();
  v_remaining int;
  v_completed boolean := false;
  v_activated boolean := false;
  v_completion jsonb;
  v_rows int;
  v_next_timer_expires_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_player_id::text)
  );

  SELECT *
    INTO v_next_pick
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No picks remaining - draft may be complete'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_next_pick.member_id <> p_member_id THEN
    RAISE EXCEPTION 'It''s not your pick'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_allow_expired_timer
     AND v_next_pick.timer_expires_at IS NOT NULL
     AND v_next_pick.timer_expires_at <= v_now THEN
    RAISE EXCEPTION 'Pick timer has expired'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock AND v_next_pick.draft_pick_id IS NULL THEN
    RAISE EXCEPTION 'Draft slot is missing its draft-pick asset'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM players
   WHERE id = p_player_id
     AND years_exp = 0
     AND nba_draft_number IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rookie draft picks must select a rookie-eligible player'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    SELECT id
      INTO v_on_roster_id
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
     FOR UPDATE;

    IF v_on_roster_id IS NOT NULL THEN
      RAISE EXCEPTION 'Player is already on a roster' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT id
    INTO v_already_picked_id
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id = p_player_id
   LIMIT 1;

  IF v_already_picked_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player already picked in this draft'
      USING ERRCODE = '23505';
  END IF;

  UPDATE snake_draft_picks
     SET player_id = p_player_id,
         picked_at = v_now,
         to_taxi = COALESCE(p_to_taxi,false),
         skipped_at = NULL,
         skip_reason = NULL,
         timer_expires_at = NULL
   WHERE id = v_next_pick.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record snake draft pick atomically'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    IF p_to_taxi THEN
      PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,p_member_id,p_player_id,'draft',p_draft_id);
    END IF;
    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      is_on_taxi,
      acquired_via
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      COALESCE(p_to_taxi,false),
      'draft'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      acquired_to_taxi,
      occurred_at
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      'draft_won',
      COALESCE(p_to_taxi,false),
      v_now
    );

    UPDATE draft_picks
       SET is_used = true,
           used_at = v_now,
           rookie_draft_id = p_draft_id
     WHERE id = v_next_pick.draft_pick_id
       AND league_id = v_draft.league_id
       AND current_owner_id = p_member_id
       AND round = v_next_pick.round
       AND is_used = false;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_remaining > 0 THEN
    v_next_timer_expires_at := private.arm_next_snake_pick_timer(
      p_draft_id,
      v_now + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  IF v_remaining = 0 THEN
    v_completion := private.complete_rookie_draft_if_ready(p_draft_id, v_now);
    v_completed := COALESCE((v_completion->>'completed')::boolean, false);
    v_activated := COALESCE((v_completion->>'activated')::boolean, false);
  END IF;

  RETURN jsonb_build_object(
    'pick', jsonb_build_object(
      'id', v_next_pick.id,
      'overall_pick', v_next_pick.overall_pick,
      'round', v_next_pick.round,
      'pick_in_round', v_next_pick.pick_in_round,
      'member_id', v_next_pick.member_id,
      'draft_pick_id', v_next_pick.draft_pick_id
    ),
    'player_id', p_player_id,
    'to_taxi', COALESCE(p_to_taxi,false),
    'remaining', v_remaining,
    'completed', v_completed,
    'activated', v_activated,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id,
    'is_mock', v_draft.is_mock,
    'next_timer_expires_at', v_next_timer_expires_at
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.close_auction_nomination_atomic(
  p_nomination_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nom nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_budget draft_budgets%ROWTYPE;
  v_roster_size int;
  v_active_roster_count int;
  v_can_sell boolean;
BEGIN
  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
     AND countdown_expires_at < now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = v_nom.draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RETURN false;
  END IF;

  IF v_nom.current_bidder_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtext(v_draft.league_id::text),
      hashtext(v_nom.current_bidder_id::text)
    );
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(v_nom.player_id::text)
  );

  SELECT COALESCE(roster_size, 20)
    INTO v_roster_size
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = v_nom.player_id
  ) THEN
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = now()
     WHERE id = v_nom.id;
  ELSIF v_nom.current_bidder_id IS NOT NULL THEN
    SELECT *
      INTO v_budget
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND member_id = v_nom.current_bidder_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Winning bidder budget not found';
    END IF;

    IF v_budget.remaining < v_nom.current_bid_amount THEN
      RAISE EXCEPTION 'Winning bidder no longer has enough remaining budget';
    END IF;

    v_can_sell := true;
    IF NOT v_draft.is_mock THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_draft.league_id
         AND league_season_id = v_draft.league_season_id
         AND member_id = v_nom.current_bidder_id
         AND COALESCE(is_on_ir, false) = false
         AND COALESCE(is_on_taxi, false) = false
       FOR UPDATE;

      SELECT count(*)
        INTO v_active_roster_count
        FROM roster_players
       WHERE league_id = v_draft.league_id
         AND league_season_id = v_draft.league_season_id
         AND member_id = v_nom.current_bidder_id
         AND COALESCE(is_on_ir, false) = false
         AND COALESCE(is_on_taxi, false) = false;

      IF v_nom.current_bid_to_taxi THEN
        v_can_sell := private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,v_nom.current_bidder_id,v_nom.player_id);
      ELSIF v_active_roster_count >= v_roster_size THEN
        v_can_sell := false;
      ELSE
        v_can_sell := true;
      END IF;
    END IF;

    IF NOT v_can_sell THEN
      UPDATE nominations
         SET status = 'no_bid',
             closed_at = now()
       WHERE id = v_nom.id;
    ELSE
      UPDATE draft_budgets
         SET remaining = remaining - v_nom.current_bid_amount
       WHERE id = v_budget.id;

      IF NOT v_draft.is_mock THEN
        IF v_nom.current_bid_to_taxi THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,v_nom.current_bidder_id,v_nom.player_id,'draft',v_draft.id);
        END IF;
        INSERT INTO roster_players (
          league_id,
          league_season_id,
          member_id,
          player_id,
          acquired_via,
          is_on_taxi,
          acquisition_cost
        )
        VALUES (
          v_draft.league_id,
          v_draft.league_season_id,
          v_nom.current_bidder_id,
          v_nom.player_id,
          'draft',
          v_nom.current_bid_to_taxi,
          v_nom.current_bid_amount
        );

        INSERT INTO roster_transactions (
          league_id,
          league_season_id,
          member_id,
          player_id,
          transaction_type,
          acquired_to_taxi,
          related_nomination_id
        )
        VALUES (
          v_draft.league_id,
          v_draft.league_season_id,
          v_nom.current_bidder_id,
          v_nom.player_id,
          'draft_won',
          v_nom.current_bid_to_taxi,
          v_nom.id
        );
      END IF;

      UPDATE nominations
         SET status = 'sold',
             winning_member_id = v_nom.current_bidder_id,
             final_price = v_nom.current_bid_amount,
             closed_at = now()
       WHERE id = v_nom.id;
    END IF;
  ELSE
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = now()
     WHERE id = v_nom.id;
  END IF;

  UPDATE drafts
     SET current_nomination_order = current_nomination_order + 1
   WHERE id = v_nom.draft_id;

  IF NOT EXISTS (
    SELECT 1
      FROM league_members lm
      JOIN draft_budgets db
        ON db.draft_id = v_nom.draft_id
       AND db.member_id = lm.id
     WHERE lm.league_id = v_draft.league_id
       AND db.remaining >= 1
       AND (
         v_draft.is_mock
         OR (
           SELECT count(*)
             FROM roster_players rp
            WHERE rp.league_id = v_draft.league_id
              AND rp.league_season_id = v_draft.league_season_id
              AND rp.member_id = lm.id
              AND COALESCE(rp.is_on_ir, false) = false
              AND COALESCE(rp.is_on_taxi, false) = false
         ) < v_roster_size
         OR private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,lm.id,NULL,v_draft.id)
       )
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = now()
     WHERE id = v_nom.draft_id;

    IF NOT v_draft.is_mock THEN
      UPDATE leagues
         SET status = 'active'
       WHERE id = v_draft.league_id;
    END IF;
  END IF;

  RETURN true;
END;
$$;


CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
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
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
  v_previous_flag text;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
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

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;

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
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

    END IF;
  END LOOP;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    UPDATE faab_balances
       SET balance = balance - v_item_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_from_member
       AND balance >= v_item_faab_amount;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  -- A reserved pick may only change hands through this completion; the
  -- draft_picks guard and the trade status guard honour this mark.
  v_previous_flag := private.begin_trade_lifecycle_write();

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

    IF v_item.player_id IS NOT NULL THEN
      IF v_item.to_taxi THEN
        PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
      END IF;
      BEGIN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade',
             is_on_taxi = v_item.to_taxi
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF NOT v_item.to_taxi THEN RAISE; END IF;
        -- A changed destination precondition expires this trade, not the whole queue.
        RAISE EXCEPTION 'Taxi acquisition failed: %', SQLERRM USING ERRCODE='PT001';
      END;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        acquired_to_taxi,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', false, p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', v_item.to_taxi, p_trade_id);
    ELSIF v_item.pick_id IS NOT NULL THEN
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
