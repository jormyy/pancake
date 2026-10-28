CREATE OR REPLACE FUNCTION public.get_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.matchup_forecast_inputs_ready(p_matchup_id)
    THEN private.read_matchup_forecast_context(p_matchup_id)
    ELSE private.compute_matchup_forecast_context(p_matchup_id) END;
$$;
