-- Canonical SQL source for public.invoke_close_expired_nominations_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_close_expired_nominations_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One cron period ahead. The edge function claims with its own, later now(),
  -- so a deadline that passes between this check and that claim still closes
  -- on this tick, exactly as when every tick invoked the function.
  v_horizon timestamptz := now() + interval '1 minute';
BEGIN
  -- Nothing can be due without an in-progress draft. Checking that first keeps
  -- an idle tick, which runs in a fresh pg_cron session, to one small plan.
  IF NOT EXISTS (
    SELECT 1 FROM public.drafts WHERE status = 'in_progress'::public.draft_status
  ) THEN
    RETURN;
  END IF;

  -- Mirrors the candidate queries of close_expired_auction_nominations_atomic
  -- and process_expired_snake_picks_atomic.
  IF EXISTS (
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
    PERFORM public.invoke_edge_function('close-expired-nominations');
  END IF;
END;
$$;
