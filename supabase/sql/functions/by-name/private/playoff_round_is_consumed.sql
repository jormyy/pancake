CREATE OR REPLACE FUNCTION private.playoff_round_is_consumed(p_season_id uuid, p_type matchup_type)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.matchups
    WHERE league_season_id = p_season_id
      AND ((p_type = 'playoff_quarterfinal' AND matchup_type IN ('playoff_semifinal', 'playoff_final'))
        OR (p_type = 'playoff_semifinal' AND matchup_type = 'playoff_final'))
  ) OR (p_type = 'playoff_final' AND EXISTS (
    SELECT 1 FROM public.league_seasons WHERE id = p_season_id AND is_current = false
  ));
$$;
