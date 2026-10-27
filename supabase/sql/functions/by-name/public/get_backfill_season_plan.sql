CREATE OR REPLACE FUNCTION public.get_backfill_season_plan(p_now timestamptz DEFAULT now())
RETURNS TABLE(source text,season_year integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH completed AS (
    SELECT season_year FROM public.season_weeks
    GROUP BY season_year HAVING max(week_end)<(p_now AT TIME ZONE 'America/New_York')::date
  ), latest AS (
    SELECT COALESCE(max(season_year),public.current_season_year_et(p_now)-1) AS season_year FROM completed
  )
  SELECT policy.source,years.season_year
  FROM private.provider_history_policy policy CROSS JOIN latest
  CROSS JOIN LATERAL generate_series(policy.first_season_year,
    LEAST(COALESCE(policy.last_season_year,latest.season_year),latest.season_year)) years(season_year)
  WHERE policy.source IN ('bbref','cdn-enum')
  ORDER BY CASE WHEN policy.source='cdn-enum' THEN 0 ELSE 1 END,years.season_year DESC;
$$;
