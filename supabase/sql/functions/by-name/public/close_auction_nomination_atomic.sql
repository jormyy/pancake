-- Canonical SQL source for public.close_auction_nomination_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_league_id uuid;
  v_bidder_id uuid;
  v_player_id uuid;
BEGIN
  SELECT draft.league_id, nomination.current_bidder_id, nomination.player_id
    INTO v_league_id, v_bidder_id, v_player_id
    FROM nominations AS nomination
    JOIN drafts AS draft ON draft.id = nomination.draft_id
   WHERE nomination.id = p_nomination_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, ARRAY[v_bidder_id], ARRAY[v_player_id]);

  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
     AND countdown_expires_at < clock_timestamp()
   FOR UPDATE;

  IF NOT FOUND
     OR v_nom.current_bidder_id IS DISTINCT FROM v_bidder_id
     OR v_nom.player_id <> v_player_id THEN
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
           closed_at = clock_timestamp()
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
             closed_at = clock_timestamp()
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
             closed_at = clock_timestamp()
       WHERE id = v_nom.id;
    END IF;
  ELSE
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = clock_timestamp()
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
           completed_at = clock_timestamp()
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
