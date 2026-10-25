-- Canonical SQL source for public.stop_draft_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
