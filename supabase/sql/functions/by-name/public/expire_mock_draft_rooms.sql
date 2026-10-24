-- Canonical SQL source for public.expire_mock_draft_rooms.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.expire_mock_draft_rooms()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
BEGIN
  DELETE FROM public.drafts AS draft
   WHERE draft.is_mock
     AND (
       (draft.status IN ('completed'::draft_status, 'cancelled'::draft_status)
         AND COALESCE(draft.completed_at, draft.created_at) < now() - interval '24 hours')
       OR (draft.status = 'pending'::draft_status
         AND COALESCE(draft.scheduled_at, draft.created_at) < now() - interval '24 hours')
       OR (draft.status IN ('in_progress'::draft_status, 'paused'::draft_status)
         AND COALESCE(
           CASE
             WHEN draft.status = 'paused' AND draft.timer_paused_remaining_seconds IS NOT NULL THEN
               COALESCE(draft.paused_at, draft.started_at, draft.created_at)
                 + make_interval(secs => draft.timer_paused_remaining_seconds)
             WHEN draft.status = 'in_progress' AND draft.draft_type = 'snake' THEN
               (SELECT pick.timer_expires_at
                  FROM public.snake_draft_picks AS pick
                 WHERE pick.draft_id = draft.id AND pick.player_id IS NULL AND pick.skipped_at IS NULL
                 ORDER BY pick.overall_pick
                 LIMIT 1)
             WHEN draft.status = 'in_progress' AND draft.draft_type = 'auction' THEN
               (SELECT nomination.countdown_expires_at
                  FROM public.nominations AS nomination
                 WHERE nomination.draft_id = draft.id AND nomination.status = 'open'
                 ORDER BY nomination.nominated_at DESC
                 LIMIT 1)
           END,
           GREATEST(
             (SELECT max(pick.picked_at) FROM public.snake_draft_picks AS pick WHERE pick.draft_id = draft.id),
             (SELECT max(nomination.closed_at) FROM public.nominations AS nomination WHERE nomination.draft_id = draft.id)
           ),
           draft.started_at,
           draft.created_at
         ) < now() - interval '24 hours')
     );

  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$;
