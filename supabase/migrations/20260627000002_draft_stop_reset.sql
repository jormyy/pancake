-- Commissioner draft controls: stop and reset an in-progress draft.

CREATE OR REPLACE FUNCTION public.stop_draft_atomic(p_draft_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status NOT IN ('in_progress', 'paused') THEN
    RAISE EXCEPTION 'Only an in-progress draft can be stopped.';
  END IF;

  UPDATE nominations
     SET status = 'no_bid',
         countdown_expires_at = NULL,
         closed_at = now()
   WHERE draft_id = p_draft_id
     AND status = 'open';

  UPDATE drafts
     SET status = 'cancelled',
         completed_at = now()
   WHERE id = p_draft_id;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_draft_atomic(p_draft_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_player_ids uuid[];
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status NOT IN ('in_progress', 'paused') THEN
    RAISE EXCEPTION 'Only an in-progress draft can be reset.';
  END IF;

  IF v_draft.draft_type = 'auction' THEN
    v_player_ids := ARRAY(
      SELECT player_id
        FROM nominations
       WHERE draft_id = p_draft_id
         AND status = 'sold'
         AND player_id IS NOT NULL
    );

    DELETE FROM roster_players
     WHERE league_season_id = v_draft.league_season_id
       AND acquired_via = 'draft'
       AND player_id = ANY(v_player_ids);

    DELETE FROM roster_transactions
     WHERE league_season_id = v_draft.league_season_id
       AND player_id = ANY(v_player_ids);

    DELETE FROM bids
     WHERE nomination_id IN (SELECT id FROM nominations WHERE draft_id = p_draft_id);
    DELETE FROM nominations WHERE draft_id = p_draft_id;

    UPDATE draft_budgets
       SET remaining = initial_budget
     WHERE draft_id = p_draft_id;

    UPDATE drafts
       SET status = 'in_progress',
           current_nomination_order = 1,
           completed_at = NULL
     WHERE id = p_draft_id;

  ELSE
    v_player_ids := ARRAY(
      SELECT player_id
        FROM snake_draft_picks
       WHERE draft_id = p_draft_id
         AND player_id IS NOT NULL
    );

    DELETE FROM roster_players
     WHERE league_season_id = v_draft.league_season_id
       AND acquired_via = 'draft'
       AND player_id = ANY(v_player_ids);

    DELETE FROM roster_transactions
     WHERE league_season_id = v_draft.league_season_id
       AND player_id = ANY(v_player_ids);

    UPDATE draft_picks
       SET is_used = false,
           used_at = NULL,
           rookie_draft_id = NULL
     WHERE rookie_draft_id = p_draft_id;

    UPDATE snake_draft_picks
       SET player_id = NULL,
           picked_at = NULL
     WHERE draft_id = p_draft_id;

    UPDATE drafts
       SET status = 'in_progress',
           current_nomination_order = 1,
           completed_at = NULL
     WHERE id = p_draft_id;
  END IF;

  UPDATE leagues
     SET status = 'drafting'
   WHERE id = v_draft.league_id;
END;
$$;

REVOKE ALL ON FUNCTION public.stop_draft_atomic(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_draft_atomic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stop_draft_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_draft_atomic(uuid) TO service_role;
