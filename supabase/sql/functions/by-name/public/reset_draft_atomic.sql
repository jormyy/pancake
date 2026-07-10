-- Canonical SQL source for public.reset_draft_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.reset_draft_atomic(
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
  v_player_ids uuid[];
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status NOT IN ('pending', 'in_progress', 'paused', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Draft cannot be reset from status %.', v_draft.status;
  END IF;

  IF v_draft.draft_type = 'auction' THEN
    v_player_ids := ARRAY(
      SELECT player_id
        FROM nominations
       WHERE draft_id = p_draft_id
         AND status = 'sold'
         AND player_id IS NOT NULL
    );

    IF NOT v_draft.is_mock THEN
      DELETE FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids);

      DELETE FROM roster_transactions
       WHERE league_season_id = v_draft.league_season_id
         AND related_nomination_id IN (
           SELECT id FROM nominations WHERE draft_id = p_draft_id
         );
    END IF;

    DELETE FROM bids
     WHERE nomination_id IN (SELECT id FROM nominations WHERE draft_id = p_draft_id);
    DELETE FROM nominations WHERE draft_id = p_draft_id;

    UPDATE draft_budgets
       SET remaining = initial_budget
     WHERE draft_id = p_draft_id;

  ELSE
    v_player_ids := ARRAY(
      SELECT player_id
        FROM snake_draft_picks
       WHERE draft_id = p_draft_id
         AND player_id IS NOT NULL
    );

    IF NOT v_draft.is_mock THEN
      DELETE FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids);

      DELETE FROM roster_transactions
       WHERE league_season_id = v_draft.league_season_id
         AND transaction_type = 'draft_won'
         AND player_id = ANY(v_player_ids);

      UPDATE draft_picks
         SET is_used = false,
             used_at = NULL,
             rookie_draft_id = NULL
       WHERE rookie_draft_id = p_draft_id;
    END IF;

    UPDATE snake_draft_picks
       SET player_id = NULL,
           picked_at = NULL,
           skipped_at = NULL,
           skip_reason = NULL,
           timer_expires_at = NULL
     WHERE draft_id = p_draft_id;

    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      now() + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         current_nomination_order = 1,
         completed_at = NULL,
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  IF NOT v_draft.is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = v_draft.league_id;
  END IF;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'reset',
    jsonb_build_object(
      'previousStatus', v_draft.status,
      'draftType', v_draft.draft_type,
      'isMock', v_draft.is_mock,
      'playersRemoved', COALESCE(array_length(v_player_ids, 1), 0)
    )
  );
END;
$$;
