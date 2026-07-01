ALTER TABLE public.snake_draft_picks
  ADD COLUMN IF NOT EXISTS timer_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_snake_draft_picks_expiring_timer
  ON public.snake_draft_picks (timer_expires_at, overall_pick)
  WHERE player_id IS NULL AND timer_expires_at IS NOT NULL;

WITH current_picks AS (
  SELECT DISTINCT ON (pick.draft_id)
    pick.id
  FROM public.snake_draft_picks AS pick
  JOIN public.drafts AS draft
    ON draft.id = pick.draft_id
   AND draft.draft_type = 'snake'
   AND draft.status = 'in_progress'
  WHERE pick.player_id IS NULL
  ORDER BY pick.draft_id, pick.overall_pick
)
UPDATE public.snake_draft_picks AS pick
   SET timer_expires_at = COALESCE(pick.timer_expires_at, now() + interval '30 seconds')
  FROM current_picks
 WHERE pick.id = current_picks.id;
