CREATE OR REPLACE FUNCTION public.get_matchup_forecast(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.matchups matchup
    JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
    JOIN public.league_members member ON member.league_id=league.id AND member.user_id=auth.uid()
    WHERE matchup.id=p_matchup_id
  ) THEN RAISE EXCEPTION 'This matchup is not available.' USING ERRCODE='42501'; END IF;
  SELECT cached.forecast||jsonb_build_object('matchupId',cached.matchup_id,'calculatedAt',cached.calculated_at,
    'inputRevision',cached.input_revision,'validUntil',cached.valid_until,
    'stale',COALESCE(queued.dirty,false) OR cached.valid_until<=now())
  INTO result FROM public.matchup_forecasts cached
  LEFT JOIN private.matchup_forecast_queue queued ON queued.matchup_id=cached.matchup_id
  WHERE cached.matchup_id=p_matchup_id;
  RETURN result;
END;
$$;
