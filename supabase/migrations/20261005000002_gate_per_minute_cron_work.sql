-- Gate the two per-minute cron jobs in SQL.
--
-- nba-close-expired-nominations and nba-dispatch-stats-sync-jobs invoked their
-- edge functions every minute (2,880 calls a day) even with nothing to do. On
-- 2026-10-05 production had no open nomination, no in-progress draft, no snake
-- pick, and no stats sync job, so every call was idle, yet each one paid a
-- pg_net request, an edge boot, fresh PostgREST connections, the claim RPCs,
-- an edge_invocations row, and a reconcile pass.
--
-- Follow invoke_live_poll_if_due(): a SQL predicate that mirrors the claim
-- queries and invokes the edge function only when work is due. The predicates
-- look one cron period ahead because the edge function claims with its own,
-- later now(); every deadline therefore closes on the same tick as before, and
-- a tick may still invoke one period early and find nothing to claim.
--
-- The cron payload of the stats dispatcher is unchanged and now lives in
-- invoke_stats_sync_dispatch_if_due(). Both functions are service_role-only,
-- like the other cron gates.
-- Canonical sources: supabase/sql/functions/by-name/public/invoke_close_expired_nominations_if_due.sql
-- and supabase/sql/functions/by-name/public/invoke_stats_sync_dispatch_if_due.sql

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

CREATE OR REPLACE FUNCTION public.invoke_stats_sync_dispatch_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One cron period ahead, as in invoke_close_expired_nominations_if_due: a
  -- retry or stale lease that falls due before the edge function claims is
  -- still picked up on this tick.
  v_horizon timestamptz := now() + interval '1 minute';
BEGIN
  -- Mirrors both candidate queries of claim_stats_sync_job_atomic (valid jobs
  -- and malformed ones it dead-letters), with the dispatcher's 120 s stale
  -- lease (p_stale_after_seconds in sync-stats).
  IF EXISTS (
    SELECT 1
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < 3
           AND COALESCE(job.completed_at, job.created_at) <= v_horizon - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
           job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= v_horizon - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= v_horizon - interval '120 seconds'
               )
             )
           )
         )
       )
  ) THEN
    PERFORM public.invoke_edge_function(
      'sync-stats',
      '{"dispatch":true,"jobId":"00000000-0000-4000-8000-000000000000"}'::jsonb
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_close_expired_nominations_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_close_expired_nominations_if_due() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_close_expired_nominations_if_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_close_expired_nominations_if_due() TO service_role;
REVOKE ALL ON FUNCTION public.invoke_stats_sync_dispatch_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_stats_sync_dispatch_if_due() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_stats_sync_dispatch_if_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_stats_sync_dispatch_if_due() TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
     WHERE jobname IN ('nba-close-expired-nominations', 'nba-dispatch-stats-sync-jobs');
    PERFORM cron.schedule(
      'nba-close-expired-nominations',
      '* * * * *',
      $$SELECT public.invoke_close_expired_nominations_if_due()$$
    );
    PERFORM cron.schedule(
      'nba-dispatch-stats-sync-jobs',
      '* * * * *',
      $$SELECT public.invoke_stats_sync_dispatch_if_due()$$
    );
  END IF;
END
$cron$;
