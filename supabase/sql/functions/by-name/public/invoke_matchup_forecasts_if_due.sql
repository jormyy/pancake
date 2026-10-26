CREATE OR REPLACE FUNCTION public.invoke_matchup_forecasts_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.matchup_forecast_queue(matchup_id)
  SELECT matchup.id FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1
    AND first_week.week_start<=(now() AT TIME ZONE 'America/New_York')::date+14
    AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue queued WHERE queued.matchup_id=matchup.id)
  ORDER BY matchup.id ON CONFLICT DO NOTHING;
  UPDATE private.matchup_forecast_queue queued SET dirty=true,revision=queued.revision+1,changed_at=now(),available_at=now()
  FROM public.matchup_forecasts cached JOIN public.matchups matchup ON matchup.id=cached.matchup_id
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE queued.matchup_id=cached.matchup_id AND NOT queued.dirty AND cached.valid_until<=now()
    AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1 AND NOT matchup.is_voided;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=now()
    AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes')) THEN
    PERFORM public.invoke_edge_function('matchup-forecast');
  END IF;
END;
$$;
