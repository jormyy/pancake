CREATE OR REPLACE FUNCTION public.get_dynasty_pick_values(p_league_id uuid)
RETURNS TABLE(draft_year integer,round integer,tier text,trade_value numeric,source text,fetched_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH league AS (
    SELECT l.*,s.id AS season_id,s.season_year,
      (SELECT count(*) FROM public.league_members WHERE league_id=l.id) AS teams
    FROM public.leagues l JOIN public.league_seasons s ON s.league_id=l.id AND s.is_current
    WHERE l.id=p_league_id AND (EXISTS(SELECT 1 FROM public.league_members WHERE league_id=l.id AND user_id=auth.uid())
      OR auth.role()='service_role')
  ), available AS MATERIALIZED (
    SELECT average.player_id,average.avg_fantasy_points FROM league
    CROSS JOIN LATERAL private.trade_value_fantasy_averages(league.id,league.season_year) average
    WHERE NOT EXISTS(SELECT 1 FROM public.roster_players roster
      WHERE roster.league_id=league.id AND roster.league_season_id=league.season_id AND roster.player_id=average.player_id)
  ), replacements AS (
    SELECT ranking.trade_value FROM available
    JOIN public.dynasty_rankings ranking ON ranking.player_id=available.player_id AND ranking.source='onenumberhoops.com'
    WHERE ranking.trade_value IS NOT NULL
    ORDER BY available.avg_fantasy_points DESC,available.player_id LIMIT 5
  ), floor AS (
    SELECT LEAST(500,COALESCE((SELECT avg(trade_value) FROM replacements),
      GREATEST(50,180.0*200/GREATEST(1,teams*roster_size)))) AS value FROM league
  )
  SELECT pick.draft_year,pick.round,pick.tier,CASE WHEN pick.round=3 THEN GREATEST(pick.trade_value,floor.value)
    ELSE pick.trade_value END,pick.source,pick.fetched_at
  FROM public.dynasty_pick_values pick CROSS JOIN floor ORDER BY pick.draft_year,pick.round,pick.tier;
$$;
REVOKE ALL ON FUNCTION public.get_dynasty_pick_values(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_dynasty_pick_values(uuid) TO authenticated,service_role;
