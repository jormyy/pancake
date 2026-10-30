-- Canonical SQL source for private.enqueue_close_expired_nominations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_close_expired_nominations(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_horizon timestamptz := p_now + interval '1 minute';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.drafts AS draft
     WHERE draft.status IN ('in_progress'::public.draft_status, 'paused'::public.draft_status)
        OR (draft.draft_type='snake' AND NOT draft.is_mock AND draft.status='completed' AND EXISTS (
          SELECT 1 FROM public.snake_draft_picks AS unmade WHERE unmade.draft_id=draft.id
            AND unmade.player_id IS NULL AND unmade.skipped_at IS NOT NULL))
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.drafts AS draft
    JOIN public.league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    WHERE draft.draft_type = 'snake' AND NOT draft.is_mock
      AND (draft.status IN ('in_progress', 'paused') OR (draft.status='completed' AND EXISTS (
        SELECT 1 FROM public.snake_draft_picks AS unmade WHERE unmade.draft_id=draft.id
          AND unmade.player_id IS NULL AND unmade.skipped_at IS NOT NULL)))
      AND private.draft_timer_opening_night_completion_enabled()
      AND private.draft_timer_opening_night_cutoff(season.season_year) < v_horizon
  ) OR EXISTS (
    SELECT 1
      FROM public.nominations AS nomination
      JOIN public.drafts AS draft
        ON draft.id = nomination.draft_id
     WHERE nomination.status = 'open'::public.nomination_status
       AND nomination.countdown_expires_at < v_horizon
       AND draft.status = 'in_progress'::public.draft_status
  ) OR EXISTS (
    SELECT 1
      FROM public.snake_draft_picks AS pick
      JOIN public.drafts AS draft
        ON draft.id = pick.draft_id
     WHERE pick.player_id IS NULL
       AND pick.skipped_at IS NULL
       AND pick.timer_expires_at IS NOT NULL
       AND pick.timer_expires_at < v_horizon
       AND draft.draft_type = 'snake'
       AND draft.status = 'in_progress'
  ) THEN
    PERFORM private.work_enqueue('close-expired-nominations',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;
