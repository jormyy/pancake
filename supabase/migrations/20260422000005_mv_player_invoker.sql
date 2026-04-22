-- Fix: public.mv_player_season_averages must be SECURITY INVOKER,
-- not SECURITY DEFINER, to satisfy the linter.
CREATE OR REPLACE VIEW public.mv_player_season_averages
  WITH (security_invoker = true)
AS
  SELECT * FROM analytics.mv_player_season_averages;

GRANT SELECT ON public.mv_player_season_averages TO authenticated, anon;
