CREATE OR REPLACE FUNCTION public.get_prepared_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.matchup_forecast_inputs_ready(p_matchup_id) THEN
    RAISE EXCEPTION 'Forecast inputs changed. Prepare them again.' USING ERRCODE='PT409';
  END IF;
  RETURN private.read_matchup_forecast_context(p_matchup_id);
END;
$$;
