CREATE OR REPLACE FUNCTION private.trade_value_player_inputs(
  p_league_id uuid, p_member_id uuid, p_season_year integer, p_player_ids uuid[], p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH input_rows AS (
WITH authorized AS (
  SELECT 1
    FROM public.league_members AS own_member
   WHERE own_member.id = p_member_id
     AND own_member.league_id = p_league_id
     AND own_member.user_id = (SELECT auth.uid())
),
candidate_ids AS (
  SELECT ranking.player_id, min(ranking.source_rank) AS sort_rank
    FROM authorized
    JOIN public.dynasty_rankings AS ranking
      ON ranking.source IN (
        'hashtagbasketball.com',
        'hashtagbasketball.com/points-3',
        'hashtagbasketball.com/rookie'
      )
     AND ranking.player_id IS NOT NULL
   WHERE p_player_ids IS NULL
   GROUP BY ranking.player_id
  UNION ALL
  SELECT requested.player_id, NULL::int
    FROM authorized
    CROSS JOIN LATERAL (
      SELECT DISTINCT player_id
        FROM unnest(p_player_ids) AS ids(player_id)
    ) AS requested
   WHERE p_player_ids IS NOT NULL
),
bounded_players AS (
  SELECT
    player.id,
    COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)) AS display_name,
    player.nba_team,
    player.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(player.eligible_positions) AS pos) AS eligible_positions,
    player.injury_status,
    player.years_exp,
    player.headshot_url,
    player.nba_id,
    five_year.id AS dynasty_ranking_id,
    five_year.source_rank AS five_year_rank,
    three_year.source_rank AS three_year_rank,
    rookie.source_rank AS rookie_rank,
    five_year.rank_change,
    five_year.age,
    five_year.source AS ranking_source,
    five_year.fetched_at AS ranking_fetched_at,
    five_year.trade_value
  FROM candidate_ids AS candidate
  JOIN public.players AS player ON player.id = candidate.player_id
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS five_year ON true
  LEFT JOIN LATERAL (
    SELECT ranking.source_rank
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com/points-3'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS three_year ON true
  LEFT JOIN LATERAL (
    SELECT ranking.source_rank
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com/rookie'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS rookie ON true
  WHERE true
     OR player.display_name ILIKE '%' || trim('') || '%'
  ORDER BY candidate.sort_rank NULLS LAST, player.display_name, player.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000)
  OFFSET GREATEST(COALESCE(0, 0), 0)
),
bounded_ids AS (
  SELECT array_agg(id ORDER BY id) AS player_ids
    FROM bounded_players
),
projections AS (
  SELECT projection.*
    FROM bounded_ids AS ids
    CROSS JOIN LATERAL public.get_league_projection_rows(
      p_league_id,
      p_season_year,
      (timezone('America/New_York', now()))::date,
      'today',
      ids.player_ids,
      1000,
      0
    ) AS projection
   WHERE ids.player_ids IS NOT NULL
),
fantasy_averages AS MATERIALIZED (
  SELECT player_id, avg_fantasy_points
    FROM public.v_player_avg_fantasy_points
   WHERE league_id = p_league_id
     AND season_year = p_season_year AND player_id=ANY(p_player_ids)
)
SELECT
  player.id AS player_id,
  player.display_name,
  player.nba_team,
  player.position,
  player.eligible_positions,
  player.injury_status,
  player.years_exp,
  player.headshot_url,
  player.nba_id,
  player.dynasty_ranking_id,
  player.five_year_rank,
  player.three_year_rank,
  player.rookie_rank,
  player.rank_change,
  player.age,
  player.ranking_source,
  player.ranking_fetched_at,
  average.games_played,
  average.avg_points,
  average.avg_rebounds,
  average.avg_assists,
  average.avg_steals,
  average.avg_blocks,
  average.avg_three_pointers_made,
  average.avg_turnovers,
  average.avg_field_goals_made,
  average.avg_field_goals_attempted,
  average.avg_free_throws_made,
  average.avg_free_throws_attempted,
  fantasy.avg_fantasy_points,
  projection.projection_fantasy_points,
  projection.projection_fetched_at,
  projection.projection_source,
  player.trade_value
FROM bounded_players AS player
LEFT JOIN public.mv_player_season_averages AS average
  ON average.player_id = player.id
 AND average.season_year = p_season_year
LEFT JOIN fantasy_averages AS fantasy
  ON fantasy.player_id = player.id
LEFT JOIN projections AS projection ON projection.player_id = player.id
ORDER BY player.five_year_rank NULLS LAST, player.display_name, player.id
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || CASE WHEN market.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'dynasty_ranking_id', market.id,
    'five_year_rank', market.source_rank,
    'rank_change', market.rank_change,
    'age', market.age,
    'ranking_source', market.source,
    'ranking_fetched_at', market.fetched_at,
    'trade_value', market.trade_value
  ) END ORDER BY player.player_id), '[]'::jsonb)
  FROM input_rows player
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings ranking
     WHERE ranking.player_id = player.player_id AND ranking.source = 'onenumberhoops.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) market ON true;
$$;
REVOKE ALL ON FUNCTION private.trade_value_player_inputs(uuid,uuid,integer,uuid[],integer) FROM PUBLIC,anon,authenticated,service_role;
