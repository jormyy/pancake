CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE expired record;
BEGIN
  INSERT INTO private.matchup_forecast_queue(matchup_id,input_fingerprint)
  SELECT matchup.id,private.matchup_forecast_input_fingerprint(matchup.id) FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided AND last_week.week_end>=(p_now AT TIME ZONE 'America/New_York')::date-1
    AND first_week.week_start<=(p_now AT TIME ZONE 'America/New_York')::date+14
    AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue queued WHERE queued.matchup_id=matchup.id)
  ORDER BY matchup.id ON CONFLICT DO NOTHING;
  FOR expired IN
    SELECT matchup.id FROM private.matchup_forecast_queue queued
    JOIN public.matchup_forecasts cached ON cached.matchup_id=queued.matchup_id
    JOIN public.matchups matchup ON matchup.id=cached.matchup_id
    JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
    WHERE NOT queued.dirty AND cached.valid_until<=p_now
      AND last_week.week_end>=(p_now AT TIME ZONE 'America/New_York')::date-1 AND NOT matchup.is_voided
    ORDER BY matchup.id
  LOOP
    PERFORM private.queue_matchup_forecasts(NULL,expired.id);
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;
