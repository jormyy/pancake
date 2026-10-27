CREATE OR REPLACE FUNCTION public.fail_matchup_forecast(p_matchup_id uuid,p_claim_token uuid,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.matchup_forecast_queue SET claimed_at=NULL,claim_token=NULL,claimed_revision=NULL,
    available_at=now()+interval '1 minute',last_error=left(p_error,1000)
  WHERE matchup_id=p_matchup_id AND claim_token=p_claim_token;
  RETURN FOUND;
END;
$$;
