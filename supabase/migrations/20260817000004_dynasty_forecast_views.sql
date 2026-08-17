-- Canonical SQL source for public.get_dynasty_forecast_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_dynasty_forecast_inputs(
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
  five_year_rank int,
  three_year_rank int,
  rookie_rank int,
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
    five_year.fetched_at AS ranking_fetched_at
  FROM candidate_ids AS candidate
  JOIN public.players AS player ON player.id = candidate.player_id
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at
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
  WHERE COALESCE(trim(p_query), '') = ''
     OR player.display_name ILIKE '%' || trim(p_query) || '%'
  ORDER BY candidate.sort_rank NULLS LAST, player.display_name, player.id
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
  projection.projection_source
FROM bounded_players AS player
LEFT JOIN public.mv_player_season_averages AS average
  ON average.player_id = player.id
 AND average.season_year = p_season_year
LEFT JOIN public.v_player_avg_fantasy_points AS fantasy
  ON fantasy.player_id = player.id
 AND fantasy.league_id = p_league_id
 AND fantasy.season_year = p_season_year
LEFT JOIN projections AS projection ON projection.player_id = player.id
ORDER BY player.five_year_rank NULLS LAST, player.display_name, player.id;
$$;

REVOKE ALL ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) IS
  'Returns one authorized batch with 5-year, 3-year, and rookie Hashtag ranks plus league production and projections.';

-- Canonical SQL source for public.replace_dynasty_rankings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings(
  p_source text,
  p_fetched_at timestamptz,
  p_rows jsonb,
  p_min_rows int DEFAULT 100,
  p_scoring_format text DEFAULT 'overall',
  p_source_url text DEFAULT NULL,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source text := NULLIF(trim(p_source), '');
  v_scoring_format text := lower(NULLIF(trim(p_scoring_format), ''));
  v_source_url text := NULLIF(trim(p_source_url), '');
  v_payload_count int;
  v_stage_count int;
  v_upserted int;
  v_deleted int;
  v_players_updated int;
  v_players_cleared int;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Ranking source is required';
  END IF;

  IF v_scoring_format IS NULL OR v_scoring_format NOT IN ('overall', 'points', 'category', 'custom') THEN
    RAISE EXCEPTION 'Ranking scoring format is invalid: %', p_scoring_format;
  END IF;

  IF p_source_metadata IS NULL OR jsonb_typeof(p_source_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Ranking source metadata must be a JSON object';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Ranking rows must be a JSON array';
  END IF;

  v_payload_count := jsonb_array_length(p_rows);
  IF v_payload_count < GREATEST(COALESCE(p_min_rows, 100), 1) THEN
    RAISE EXCEPTION 'Ranking row count % is below minimum %', v_payload_count, p_min_rows;
  END IF;

  WITH stage AS (
    SELECT
      CASE
        WHEN NULLIF(item ->> 'source_rank', '') ~ '^[0-9]+$' THEN (item ->> 'source_rank')::int
        ELSE NULL
      END AS source_rank,
      NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  SELECT count(*) INTO v_stage_count FROM stage;

  IF v_stage_count <> v_payload_count THEN
    RAISE EXCEPTION 'Staged ranking row count % does not match payload count %', v_stage_count, v_payload_count;
  END IF;

  IF EXISTS (
    WITH stage AS (
      SELECT
        CASE
          WHEN NULLIF(item ->> 'source_rank', '') ~ '^[0-9]+$' THEN (item ->> 'source_rank')::int
          ELSE NULL
        END AS source_rank,
        NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name
      FROM jsonb_array_elements(p_rows) AS rows(item)
    )
    SELECT 1
    FROM stage
    WHERE source_rank IS NULL OR source_rank <= 0 OR source_player_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains invalid rank or player name';
  END IF;

  IF EXISTS (
    SELECT (item ->> 'source_rank')::int AS source_rank
    FROM jsonb_array_elements(p_rows) AS rows(item)
    GROUP BY (item ->> 'source_rank')::int
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains duplicate source ranks';
  END IF;

  WITH stage AS (
    SELECT
      v_source AS source,
      v_scoring_format AS scoring_format,
      v_source_url AS source_url,
      p_source_metadata AS source_metadata,
      (item ->> 'source_rank')::int AS source_rank,
      NULLIF(item ->> 'source_player_id', '') AS source_player_id,
      NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name,
      NULLIF(item ->> 'source_team', '') AS source_team,
      COALESCE(
        ARRAY(
          SELECT jsonb_array_elements_text(COALESCE(item -> 'source_positions', '[]'::jsonb))
        ),
        '{}'::text[]
      ) AS source_positions,
      NULLIF(item ->> 'player_id', '')::uuid AS player_id,
      NULLIF(item ->> 'age', '')::numeric(4,1) AS age,
      COALESCE(NULLIF(item ->> 'rank_change', '')::int, 0) AS rank_change,
      NULLIF(item ->> 'games_played', '')::int AS games_played,
      NULLIF(item ->> 'field_goal_pct', '')::numeric(5,3) AS field_goal_pct,
      NULLIF(item ->> 'free_throw_pct', '')::numeric(5,3) AS free_throw_pct,
      NULLIF(item ->> 'three_pointers_made', '')::numeric(5,1) AS three_pointers_made,
      NULLIF(item ->> 'points', '')::numeric(5,1) AS points,
      NULLIF(item ->> 'rebounds', '')::numeric(5,1) AS rebounds,
      NULLIF(item ->> 'assists', '')::numeric(5,1) AS assists,
      NULLIF(item ->> 'steals', '')::numeric(5,1) AS steals,
      NULLIF(item ->> 'blocks', '')::numeric(5,1) AS blocks,
      NULLIF(item ->> 'turnovers', '')::numeric(5,1) AS turnovers,
      NULLIF(item ->> 'comment', '') AS comment,
      p_fetched_at AS fetched_at
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  INSERT INTO public.dynasty_rankings (
    source,
    scoring_format,
    source_url,
    source_metadata,
    source_rank,
    source_player_id,
    source_player_name,
    source_team,
    source_positions,
    player_id,
    age,
    rank_change,
    games_played,
    field_goal_pct,
    free_throw_pct,
    three_pointers_made,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    comment,
    fetched_at,
    updated_at
  )
  SELECT
    source,
    scoring_format,
    source_url,
    source_metadata,
    source_rank,
    source_player_id,
    source_player_name,
    source_team,
    source_positions,
    player_id,
    age,
    rank_change,
    games_played,
    field_goal_pct,
    free_throw_pct,
    three_pointers_made,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    comment,
    fetched_at,
    now()
  FROM stage
  ON CONFLICT (source, source_rank) DO UPDATE SET
    scoring_format = EXCLUDED.scoring_format,
    source_url = EXCLUDED.source_url,
    source_metadata = EXCLUDED.source_metadata,
    source_player_id = EXCLUDED.source_player_id,
    source_player_name = EXCLUDED.source_player_name,
    source_team = EXCLUDED.source_team,
    source_positions = EXCLUDED.source_positions,
    player_id = EXCLUDED.player_id,
    age = EXCLUDED.age,
    rank_change = EXCLUDED.rank_change,
    games_played = EXCLUDED.games_played,
    field_goal_pct = EXCLUDED.field_goal_pct,
    free_throw_pct = EXCLUDED.free_throw_pct,
    three_pointers_made = EXCLUDED.three_pointers_made,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    comment = EXCLUDED.comment,
    fetched_at = EXCLUDED.fetched_at,
    updated_at = now();
  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  WITH stage AS (
    SELECT
      (item ->> 'source_rank')::int AS source_rank
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  DELETE FROM public.dynasty_rankings AS ranking
  WHERE ranking.source = v_source
    AND NOT EXISTS (
      SELECT 1
      FROM stage
      WHERE stage.source_rank = ranking.source_rank
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_source = 'hashtagbasketball.com' THEN
    WITH stage AS (
      SELECT
        (item ->> 'source_rank')::int AS source_rank,
        NULLIF(item ->> 'player_id', '')::uuid AS player_id
      FROM jsonb_array_elements(p_rows) AS rows(item)
    ),
    best_rank AS (
      SELECT DISTINCT ON (player_id)
        player_id,
        source_rank
      FROM stage
      WHERE player_id IS NOT NULL
      ORDER BY player_id, source_rank
    )
    UPDATE public.players AS player
       SET dynasty_rank = best_rank.source_rank,
           dynasty_rank_source = v_source,
           dynasty_rank_fetched_at = p_fetched_at
      FROM best_rank
     WHERE player.id = best_rank.player_id;
    GET DIAGNOSTICS v_players_updated = ROW_COUNT;

    WITH stage AS (
      SELECT
        NULLIF(item ->> 'player_id', '')::uuid AS player_id
      FROM jsonb_array_elements(p_rows) AS rows(item)
    )
    UPDATE public.players AS player
       SET dynasty_rank = NULL,
           dynasty_rank_source = NULL,
           dynasty_rank_fetched_at = NULL
     WHERE player.dynasty_rank_source = v_source
       AND NOT EXISTS (
         SELECT 1
         FROM stage
         WHERE stage.player_id = player.id
       );
    GET DIAGNOSTICS v_players_cleared = ROW_COUNT;
  ELSE
    v_players_updated := 0;
    v_players_cleared := 0;
  END IF;

  RETURN jsonb_build_object(
    'rows', v_stage_count,
    'scoringFormat', v_scoring_format,
    'sourceUrl', v_source_url,
    'upserted', v_upserted,
    'deleted', v_deleted,
    'playersUpdated', v_players_updated,
    'playersCleared', v_players_cleared
  );
END;
$$;

-- Canonical SQL source for public.invoke_dynasty_ranking_views_at_et_time.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.

CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp;
BEGIN
  v_now := timezone('America/New_York', now());
  IF EXTRACT(HOUR FROM v_now)::int = p_hour
     AND EXTRACT(MINUTE FROM v_now)::int = p_minute THEN
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"CONTEND"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"REBUILD"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_3"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_5"}'::jsonb);
  END IF;
END;
$$;

-- Keep only indexes used by the exact-source rank lookups and player joins.
DROP INDEX IF EXISTS public.idx_dynasty_rankings_source_player;
DROP INDEX IF EXISTS public.idx_dynasty_rankings_player;
DROP INDEX IF EXISTS public.idx_dynasty_rankings_fetched_at;
ANALYZE public.dynasty_rankings;
