CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL, p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.matchup_forecast_queue AS queued(matchup_id, revision, changed_at, dirty, input_fingerprint)
  SELECT matchup.id, 1, transaction_timestamp(), true,private.matchup_forecast_input_fingerprint(matchup.id)
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
    revision=queued.revision+CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN 1 ELSE 0 END,
    changed_at=CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN transaction_timestamp() ELSE queued.changed_at END,
    dirty=queued.computed_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs',
    available_at=CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN now() ELSE queued.available_at END,
    input_fingerprint=EXCLUDED.input_fingerprint
  WHERE queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs'
    OR (queued.input_fingerprint->>'validUntil')::timestamptz<=now();
  UPDATE public.matchup_forecasts cached SET valid_until=GREATEST((queued.input_fingerprint->>'validUntil')::timestamptz,now()+interval '1 second')
  FROM private.matchup_forecast_queue queued WHERE cached.matchup_id=queued.matchup_id
    AND NOT queued.dirty AND cached.valid_until<=now()
    AND (p_league_id IS NULL OR cached.league_id=p_league_id)
    AND (p_matchup_id IS NULL OR cached.matchup_id=p_matchup_id);
$$;
