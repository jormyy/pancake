CREATE OR REPLACE FUNCTION public.player_window_averages(p_league_id uuid, p_days integer, p_player_ids uuid[] DEFAULT NULL)
RETURNS TABLE(player_id uuid, season_year integer, avg_fantasy_points numeric,
  avg_points numeric, avg_rebounds numeric, avg_assists numeric, avg_steals numeric,
  avg_blocks numeric, avg_turnovers numeric, avg_three_pointers_made numeric,
  avg_minutes_played numeric, games_played integer)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH selected_window AS MATERIALIZED (SELECT public.stats_window(p_days) AS dates)
  SELECT s.player_id, public.current_season_year_et(), round(avg(fp.fantasy_points), 2),
    round(avg(s.points), 1), round(avg(s.rebounds), 1), round(avg(s.assists), 1),
    round(avg(s.steals), 2), round(avg(s.blocks), 2), round(avg(s.turnovers), 2),
    round(avg(s.three_pointers_made), 2), round(avg(s.minutes_played), 1), count(*)::integer
  FROM selected_window
  JOIN public.nba_games g ON g.game_date BETWEEN (dates->>'startDate')::date AND (dates->>'endDate')::date
    AND public.is_regular_season_game_id(g.nba_game_id)
  JOIN public.player_game_stats s ON s.game_id = g.id AND NOT s.did_not_play
  LEFT JOIN public.v_fantasy_points fp ON fp.stat_id = s.id AND fp.league_id = p_league_id
  WHERE p_days IS NOT NULL AND (p_player_ids IS NULL OR s.player_id = ANY(p_player_ids))
  GROUP BY s.player_id;
$$;
