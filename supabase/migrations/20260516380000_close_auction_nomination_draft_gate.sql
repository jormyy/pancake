-- Gate close_auction_nomination_atomic on drafts.status = 'in_progress'.
--
-- Finding:
-- - close_auction_nomination_atomic locks the drafts row but never checks
--   drafts.status. Sibling place_auction_bid_atomic was gated in iter 37
--   (20260516370000_place_auction_bid_draft_status_gate.sql); the close path
--   must honor the same gate so a commissioner pause/cancel of the draft cannot
--   race the cron worker. The close path inserts roster_players, debits
--   draft_budgets, and updates leagues.status='active' when the auction
--   completes — none of that should run if the draft has been moved out of an
--   active state.
--
-- This migration is idempotent: it CREATE OR REPLACEs the function with the
-- same signature, preserving all existing logic and lock ordering (nominations
-- row → drafts row → optional draft_budgets row), and adds a status check on
-- the already-locked v_draft before any nomination/budget/roster mutation. The
-- grant/revoke pattern from the original migration is reapplied so this stands
-- alone if replayed.

DO $migration$
BEGIN
  EXECUTE $close_nomination_sql$
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

  -- Mirror place_auction_bid_atomic's drafts.status='in_progress' gate so a
  -- paused/cancelled/completed draft cannot trigger roster inserts, budget
  -- debits, or league activation via a late-arriving close.
  IF v_draft.status <> 'in_progress' THEN
    RETURN false;
  END IF;

  IF EXISTS (
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

    UPDATE draft_budgets
       SET remaining = remaining - v_nom.current_bid_amount
     WHERE id = v_budget.id;

    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      acquired_via,
      acquisition_cost
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      v_nom.current_bidder_id,
      v_nom.player_id,
      'draft',
      v_nom.current_bid_amount
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      related_nomination_id
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      v_nom.current_bidder_id,
      v_nom.player_id,
      'draft_won',
      v_nom.id
    );

    UPDATE nominations
       SET status = 'sold',
           winning_member_id = v_nom.current_bidder_id,
           final_price = v_nom.current_bid_amount,
           closed_at = now()
     WHERE id = v_nom.id;
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
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND remaining >= 1
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = now()
     WHERE id = v_nom.draft_id;

    UPDATE leagues
       SET status = 'active'
     WHERE id = v_draft.league_id;
  END IF;

  RETURN true;
END;
$$;
$close_nomination_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.close_auction_nomination_atomic(uuid) TO service_role';
END
$migration$;
