CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL, p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.matchup_forecast_queue AS queued(matchup_id, revision, changed_at, dirty)
  SELECT matchup.id, 1, transaction_timestamp(), true
  FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided
    AND (p_league_id IS NULL OR matchup.league_id=p_league_id)
    AND (p_matchup_id IS NULL OR matchup.id=p_matchup_id)
    AND last_week.week_end >= (now() AT TIME ZONE 'America/New_York')::date - 1
    AND first_week.week_start <= (now() AT TIME ZONE 'America/New_York')::date + 14
  ORDER BY matchup.id
  ON CONFLICT(matchup_id) DO UPDATE SET
    revision=CASE WHEN queued.changed_at=transaction_timestamp() THEN queued.revision ELSE queued.revision+1 END,
    changed_at=transaction_timestamp(), dirty=true, available_at=now();
$$;
