BEGIN;
CREATE OR REPLACE FUNCTION public.get_stale_score_weeks(p_league_season_id uuid, p_through_week int)
RETURNS TABLE(week_number int) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH eligible_weeks AS MATERIALIZED (
    SELECT DISTINCT matchup.week_number
    FROM public.matchups matchup
    WHERE matchup.league_season_id = p_league_season_id AND matchup.week_number <= p_through_week
      AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id)
      AND matchup.is_finalized IS TRUE AND NOT matchup.is_voided
      AND NOT private.playoff_matchup_is_consumed(matchup.id)
  )
  SELECT eligible.week_number
  FROM eligible_weeks eligible
  LEFT JOIN private.score_week_certificates certificate
    ON certificate.league_season_id = p_league_season_id AND certificate.week_number = eligible.week_number
  WHERE certificate.input_token IS NULL
    OR certificate.input_token IS DISTINCT FROM private.score_input_token(p_league_season_id, eligible.week_number)
  ORDER BY eligible.week_number;
$$;
COMMIT;
