-- a gate that wakes for ANY Final game on the candidate dates, ignoring stats
CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (timezone('America/New_York', now()))::date;
BEGIN
  IF EXISTS (SELECT 1 FROM public.nba_games WHERE game_date IN (v_today - 1, v_today)) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END; $$;
