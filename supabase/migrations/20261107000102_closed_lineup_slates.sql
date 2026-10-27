CREATE OR REPLACE FUNCTION private.clear_future_unlocked_lineups(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.player_id = p_player_id
     AND (p_member_id IS NULL OR wl.member_id = p_member_id)
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT EXISTS (
       SELECT 1 FROM public.nba_games g
       JOIN public.league_seasons s ON s.id=wl.league_season_id AND s.season_year=g.season_year
       WHERE g.game_date=wl.game_date
       GROUP BY g.game_date HAVING bool_and(g.status='Final')
     )
     AND NOT private.lineup_game_started(wl.player_id, wl.game_date);
$$;
