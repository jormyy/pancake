CREATE OR REPLACE FUNCTION private.live_slate_in_progress(p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.nba_games game
    WHERE game.status='InProgress' AND private.lineup_game_available(game.status,game.game_status_text)
      AND public.is_regular_season_game_id(game.nba_game_id)
      AND game.game_date BETWEEN (p_now AT TIME ZONE 'America/New_York')::date-1
        AND (p_now AT TIME ZONE 'America/New_York')::date);
$$;
REVOKE ALL ON FUNCTION private.live_slate_in_progress(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
