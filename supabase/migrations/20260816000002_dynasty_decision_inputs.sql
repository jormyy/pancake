-- Batched and identity-scoped inputs for Dynasty Rankings and Trade Analyzer.

CREATE OR REPLACE FUNCTION public.get_dynasty_decision_inputs(
  p_league_id uuid,
  p_member_id uuid,
  p_season_year int DEFAULT public.current_season_year_et(),
  p_player_ids uuid[] DEFAULT NULL,
  p_query text DEFAULT '',
  p_limit int DEFAULT 600,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  player_id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  injury_status text,
  years_exp int,
  headshot_url text,
  nba_id text,
  dynasty_ranking_id uuid,
  dynasty_rank int,
  rank_change int,
  age numeric,
  ranking_source text,
  ranking_fetched_at timestamptz,
  games_played numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_three_pointers_made numeric,
  avg_turnovers numeric,
  avg_field_goals_made numeric,
  avg_field_goals_attempted numeric,
  avg_free_throws_made numeric,
  avg_free_throws_attempted numeric,
  avg_fantasy_points numeric,
  projection_fantasy_points numeric,
  projection_fetched_at timestamptz,
  projection_source text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH authorized AS (
  SELECT 1
    FROM public.league_members AS own_member
   WHERE own_member.id = p_member_id
     AND own_member.league_id = p_league_id
     AND own_member.user_id = (SELECT auth.uid())
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
    ranking.id AS dynasty_ranking_id,
    ranking.source_rank AS dynasty_rank,
    ranking.rank_change,
    ranking.age,
    ranking.source AS ranking_source,
    ranking.fetched_at AS ranking_fetched_at
  FROM authorized
  JOIN public.players AS player ON true
  LEFT JOIN LATERAL (
    SELECT row.id, row.source_rank, row.rank_change, row.age, row.source, row.fetched_at
      FROM public.dynasty_rankings AS row
     WHERE row.player_id = player.id
       AND row.source = 'hashtagbasketball.com'
     ORDER BY row.fetched_at DESC, row.source_rank ASC, row.id ASC
     LIMIT 1
  ) AS ranking ON true
  WHERE (p_player_ids IS NULL OR player.id = ANY(p_player_ids))
    AND (COALESCE(trim(p_query), '') = '' OR player.display_name ILIKE '%' || trim(p_query) || '%')
  ORDER BY ranking.source_rank ASC NULLS LAST, player.display_name ASC, player.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
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
)
SELECT
  player.id,
  player.display_name,
  player.nba_team,
  player.position,
  player.eligible_positions,
  player.injury_status,
  player.years_exp,
  player.headshot_url,
  player.nba_id,
  player.dynasty_ranking_id,
  player.dynasty_rank,
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
  projection.projection_source
FROM bounded_players AS player
LEFT JOIN public.mv_player_season_averages AS average
  ON average.player_id = player.id
 AND average.season_year = p_season_year
LEFT JOIN public.v_player_avg_fantasy_points AS fantasy
  ON fantasy.player_id = player.id
 AND fantasy.league_id = p_league_id
 AND fantasy.season_year = p_season_year
LEFT JOIN projections AS projection
  ON projection.player_id = player.id
ORDER BY player.dynasty_rank ASC NULLS LAST, player.display_name ASC, player.id ASC;
$$;

REVOKE ALL ON FUNCTION public.get_dynasty_decision_inputs(uuid, uuid, int, uuid[], text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dynasty_decision_inputs(uuid, uuid, int, uuid[], text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dynasty_decision_inputs(uuid, uuid, int, uuid[], text, int, int) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_dynasty_rankings_player_source_fetched
  ON public.dynasty_rankings (player_id, source, fetched_at DESC, source_rank)
  WHERE player_id IS NOT NULL;
