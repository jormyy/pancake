CREATE OR REPLACE FUNCTION private.notif_first_scoring_day(p_league_season_id uuid)
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT min(game.game_date)
  FROM public.league_seasons season
  JOIN LATERAL (
    SELECT week.week_start,week.week_end FROM public.season_weeks week
    WHERE week.season_year=season.season_year AND NOT week.week_number=ANY(season.skipped_weeks)
    ORDER BY week.week_number LIMIT 1
  ) first_week ON true
  JOIN public.nba_games game ON game.season_year=season.season_year
    AND game.game_date BETWEEN first_week.week_start AND first_week.week_end
    AND game.nba_game_id ~ '^002[0-9]{7}$'
    AND private.lineup_game_available(game.status,game.game_status_text)
  WHERE season.id=p_league_season_id;
$$;
