CREATE OR REPLACE FUNCTION private.notif_player_games(p_player uuid,p_date date)
RETURNS SETOF public.nba_games
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH participation AS (
    SELECT game_id FROM public.player_game_stats WHERE player_id=p_player
    UNION SELECT game_id FROM private.player_game_memberships WHERE player_id=p_player
  )
  SELECT g.* FROM public.nba_games g JOIN public.players p ON p.id=p_player
  WHERE g.game_date=p_date AND (
    ((g.home_team=p.nba_team OR g.away_team=p.nba_team) AND NOT EXISTS (
      SELECT 1 FROM participation x JOIN public.nba_games actual ON actual.id=x.game_id WHERE actual.game_date=p_date))
    OR EXISTS(SELECT 1 FROM participation x WHERE x.game_id=g.id)
  );
$$;
