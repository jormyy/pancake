-- Canonical SQL source for public.delete_league_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.delete_league_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_user_id uuid := (SELECT auth.uid());
  v_league leagues%ROWTYPE;
  v_previous_status league_status;
  v_cancelled_drafts int := 0;
  v_closed_nominations int := 0;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM league_members AS member
     WHERE member.league_id = p_league_id
       AND member.user_id = v_actor_user_id
       AND member.role IN ('commissioner', 'co_commissioner')
  ) THEN
    RAISE EXCEPTION 'Only the league commissioner can delete this league.'
      USING ERRCODE = '42501';
  END IF;

  IF v_league.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'alreadyDeleted', true,
      'leagueId', p_league_id,
      'deletedAt', v_league.deleted_at
    );
  END IF;

  v_previous_status := v_league.status;

  UPDATE nominations AS nomination
     SET status = 'no_bid',
         countdown_expires_at = NULL,
         closed_at = now()
    FROM drafts AS draft
   WHERE nomination.draft_id = draft.id
     AND draft.league_id = p_league_id
     AND nomination.status = 'open';
  GET DIAGNOSTICS v_closed_nominations = ROW_COUNT;

  UPDATE snake_draft_picks AS pick
     SET timer_expires_at = NULL
    FROM drafts AS draft
   WHERE pick.draft_id = draft.id
     AND draft.league_id = p_league_id
     AND pick.player_id IS NULL;

  UPDATE drafts
     SET status = 'cancelled',
         completed_at = COALESCE(completed_at, now()),
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE league_id = p_league_id
     AND status IN ('pending', 'in_progress', 'paused');
  GET DIAGNOSTICS v_cancelled_drafts = ROW_COUNT;

  UPDATE leagues
     SET status = 'archived',
         deleted_at = now(),
         deleted_by = v_actor_user_id
   WHERE id = p_league_id
     AND deleted_at IS NULL
   RETURNING * INTO v_league;

  INSERT INTO league_audit_logs (league_id, actor_user_id, action, metadata)
  VALUES (
    p_league_id,
    v_actor_user_id,
    'delete',
    jsonb_build_object(
      'previousStatus', v_previous_status,
      'cancelledDrafts', v_cancelled_drafts,
      'closedNominations', v_closed_nominations,
      'retention', 'soft_delete'
    )
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'alreadyDeleted', false,
    'leagueId', p_league_id,
    'deletedAt', v_league.deleted_at,
    'cancelledDrafts', v_cancelled_drafts,
    'closedNominations', v_closed_nominations
  );
END;
$$;
