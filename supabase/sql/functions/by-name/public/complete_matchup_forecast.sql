CREATE OR REPLACE FUNCTION public.complete_matchup_forecast(
  p_matchup_id uuid, p_revision bigint, p_claim_token uuid, p_forecast jsonb, p_valid_until timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.matchup_forecast_queue%ROWTYPE; forecast_league_id uuid;
BEGIN
  SELECT league.id INTO forecast_league_id FROM public.leagues league
  JOIN public.matchups matchup ON matchup.league_id=league.id
  WHERE matchup.id=p_matchup_id FOR KEY SHARE OF league;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.matchups matchup
  WHERE matchup.id=p_matchup_id AND matchup.league_id=forecast_league_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO queued FROM private.matchup_forecast_queue WHERE matchup_id=p_matchup_id FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS DISTINCT FROM p_claim_token OR queued.claimed_revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;
  IF queued.revision<>p_revision THEN
    UPDATE private.matchup_forecast_queue SET claim_token=NULL,claimed_at=NULL,claimed_revision=NULL WHERE matchup_id=p_matchup_id;
    RETURN false;
  END IF;
  IF jsonb_typeof(p_forecast) IS DISTINCT FROM 'object' OR p_forecast->>'modelVersion' IS NULL
    OR jsonb_typeof(p_forecast->'teams') IS DISTINCT FROM 'array' OR jsonb_array_length(p_forecast->'teams')<>2 THEN
    RAISE EXCEPTION 'A complete versioned forecast is required.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until)
  VALUES(p_matchup_id,forecast_league_id,p_revision,p_forecast,now(),GREATEST(COALESCE(p_valid_until,now()+interval '1 day'),now()+interval '1 second'))
  ON CONFLICT(matchup_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,forecast=EXCLUDED.forecast,
    calculated_at=EXCLUDED.calculated_at,valid_until=EXCLUDED.valid_until;
  UPDATE private.matchup_forecast_queue SET dirty=false,claim_token=NULL,claimed_at=NULL,claimed_revision=NULL,last_error=NULL
  WHERE matchup_id=p_matchup_id;
  RETURN true;
END;
$$;
