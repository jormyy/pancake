CREATE OR REPLACE FUNCTION private.trade_revaluation_is_live(p_trade_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM public.trades trade
    JOIN public.league_seasons season ON season.league_id=trade.league_id AND season.is_current
    JOIN public.nba_games game ON game.season_year=season.season_year AND game.status='InProgress'
    WHERE trade.id=p_trade_id AND trade.status IN ('pending','accepted'));
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_is_live(uuid) FROM PUBLIC,anon,authenticated,service_role;
