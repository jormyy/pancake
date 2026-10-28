CREATE OR REPLACE FUNCTION private.trade_value_player_inputs(
  p_league_id uuid, p_member_id uuid, p_season_year integer, p_player_ids uuid[], p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || CASE WHEN market.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'dynasty_ranking_id', market.id,
    'five_year_rank', market.source_rank,
    'rank_change', market.rank_change,
    'age', market.age,
    'ranking_source', market.source,
    'ranking_fetched_at', market.fetched_at,
    'trade_value', market.trade_value
  ) END ORDER BY player.player_id), '[]'::jsonb)
  FROM public.get_dynasty_forecast_inputs(p_league_id, p_member_id, p_season_year, p_player_ids, '', p_limit, 0) player
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings ranking
     WHERE ranking.player_id = player.player_id AND ranking.source = 'onenumberhoops.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) market ON true;
$$;
REVOKE ALL ON FUNCTION private.trade_value_player_inputs(uuid,uuid,integer,uuid[],integer) FROM PUBLIC,anon,authenticated,service_role;
