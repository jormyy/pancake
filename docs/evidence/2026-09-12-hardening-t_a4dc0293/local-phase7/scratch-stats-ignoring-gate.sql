-- NEGATIVE-PROOF SCRATCH ONLY. Installed inside a rolled-back test transaction to show that
-- tests/db/live-poll-gate-and-lease.sql goes red against a gate that ignores whether a Final game
-- has its box score. It wakes on ANY game on the candidate dates (no status filter at all, which is
-- broader than 'any Final game'). Never load this outside that test; nothing in the repo does.
-- a gate that wakes for ANY game on the candidate dates (no status filter), ignoring stats
CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (timezone('America/New_York', now()))::date;
BEGIN
  IF EXISTS (SELECT 1 FROM public.nba_games WHERE game_date IN (v_today - 1, v_today)) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END; $$;
