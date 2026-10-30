-- Canonical SQL source for public.get_dynasty_pick_values.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  ), extended AS (
    SELECT pick.draft_year,pick.round,pick.tier,pick.trade_value,pick.source,pick.derived,pick.fetched_at
    FROM public.dynasty_pick_values pick
    UNION ALL
    SELECT year.value,pick.round,pick.tier,
      round(pick.trade_value*power(LEAST(1,GREATEST(0.5,COALESCE(pick.trade_value/NULLIF(previous.trade_value,0),0.9))),
        year.value-pick.draft_year),2),pick.source,true,pick.fetched_at
    FROM public.dynasty_pick_values pick
    LEFT JOIN public.dynasty_pick_values previous ON previous.draft_year=pick.draft_year-1
      AND previous.round=pick.round AND previous.tier=pick.tier AND previous.source=pick.source
    CROSS JOIN league
    CROSS JOIN LATERAL generate_series(pick.draft_year+1,league.season_year+league.future_pick_years-1) year(value)
    WHERE pick.draft_year=(SELECT max(last.draft_year) FROM public.dynasty_pick_values last
      WHERE last.round=pick.round AND last.tier=pick.tier AND last.source=pick.source)
  )
  SELECT pick.draft_year,pick.round,pick.tier,CASE WHEN pick.round=3 THEN GREATEST(pick.trade_value,floor.value)
    ELSE pick.trade_value END,pick.source,pick.fetched_at
  FROM extended pick CROSS JOIN floor CROSS JOIN league
  WHERE pick.draft_year <= league.season_year+league.future_pick_years-1 ORDER BY pick.draft_year,pick.round,pick.tier;
$$;
