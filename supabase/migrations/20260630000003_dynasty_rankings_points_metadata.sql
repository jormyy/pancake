ALTER TABLE public.dynasty_rankings
  ADD COLUMN IF NOT EXISTS scoring_format text NOT NULL DEFAULT 'overall',
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.dynasty_rankings
  DROP CONSTRAINT IF EXISTS dynasty_rankings_scoring_format_known;

ALTER TABLE public.dynasty_rankings
  ADD CONSTRAINT dynasty_rankings_scoring_format_known
  CHECK (scoring_format IN ('overall', 'points', 'category', 'custom'));

UPDATE public.dynasty_rankings
   SET source_url = COALESCE(source_url, 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'),
       source_metadata = CASE
         WHEN source_metadata = '{}'::jsonb
           THEN jsonb_build_object(
             'requestedRankingType', 'OVERALL',
             'selectedRankingType', 'OVERALL',
             'requestMethod', 'GET',
             'forecastSeasons', 5
           )
         ELSE source_metadata
       END
 WHERE source = 'hashtagbasketball.com';

DROP FUNCTION IF EXISTS public.replace_dynasty_rankings(text, timestamptz, jsonb, int);

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

REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb) TO service_role;
