CREATE OR REPLACE FUNCTION public.get_stale_score_weeks(p_league_season_id uuid, p_through_week int)
RETURNS TABLE(week_number int) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT matchup.week_number
  FROM public.matchups matchup
  LEFT JOIN private.score_week_certificates certificate
    ON certificate.league_season_id = matchup.league_season_id AND certificate.week_number = matchup.week_number
  WHERE matchup.league_season_id = p_league_season_id AND matchup.week_number <= p_through_week
    AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id)
    AND matchup.is_finalized IS TRUE
    AND NOT private.playoff_round_is_consumed(p_league_season_id, matchup.matchup_type)
    AND (certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token(p_league_season_id, matchup.week_number))
  ORDER BY matchup.week_number;
$$;
