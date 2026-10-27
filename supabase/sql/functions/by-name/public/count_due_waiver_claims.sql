CREATE OR REPLACE FUNCTION public.count_due_waiver_claims(p_process_date date)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.waiver_claims candidate
  JOIN public.leagues league ON league.id=candidate.league_id AND league.status IN ('active','playoffs','offseason')
  JOIN public.league_seasons season ON season.id=candidate.league_season_id AND season.is_current
  WHERE candidate.status='pending' AND candidate.process_date<=p_process_date
    AND (candidate.process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now()
    AND NOT EXISTS (SELECT 1 FROM public.waiver_wire_log wire WHERE wire.league_id=candidate.league_id
      AND wire.league_season_id=candidate.league_season_id AND wire.player_id=candidate.player_id
      AND wire.cleared_at IS NULL AND wire.clears_at > (candidate.process_date + time '03:00') AT TIME ZONE 'America/New_York');
$$;
