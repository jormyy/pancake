CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings(
  p_source text,
  p_fetched_at timestamptz,
  p_rows jsonb,
  p_min_rows int DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text := NULLIF(trim(p_source), '');
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

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Ranking rows must be a JSON array';
  END IF;

  v_payload_count := jsonb_array_length(p_rows);
  IF v_payload_count < GREATEST(COALESCE(p_min_rows, 100), 1) THEN
    RAISE EXCEPTION 'Ranking row count % is below minimum %', v_payload_count, p_min_rows;
  END IF;

  DROP TABLE IF EXISTS pg_temp.dynasty_rankings_stage;
  CREATE TEMP TABLE dynasty_rankings_stage (
    source text NOT NULL,
    source_rank int NOT NULL,
    source_player_id text,
    source_player_name text NOT NULL,
    source_team text,
    source_positions text[] NOT NULL,
    player_id uuid,
    age numeric(4,1),
    rank_change int NOT NULL,
    games_played int,
    field_goal_pct numeric(5,3),
    free_throw_pct numeric(5,3),
    three_pointers_made numeric(5,1),
    points numeric(5,1),
    rebounds numeric(5,1),
    assists numeric(5,1),
    steals numeric(5,1),
    blocks numeric(5,1),
    turnovers numeric(5,1),
    comment text,
    fetched_at timestamptz NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO dynasty_rankings_stage (
    source,
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
    fetched_at
  )
  SELECT
    v_source,
    (item ->> 'source_rank')::int,
    NULLIF(item ->> 'source_player_id', ''),
    NULLIF(trim(item ->> 'source_player_name'), ''),
    NULLIF(item ->> 'source_team', ''),
    COALESCE(
      ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(item -> 'source_positions', '[]'::jsonb))
      ),
      '{}'::text[]
    ),
    NULLIF(item ->> 'player_id', '')::uuid,
    NULLIF(item ->> 'age', '')::numeric(4,1),
    COALESCE(NULLIF(item ->> 'rank_change', '')::int, 0),
    NULLIF(item ->> 'games_played', '')::int,
    NULLIF(item ->> 'field_goal_pct', '')::numeric(5,3),
    NULLIF(item ->> 'free_throw_pct', '')::numeric(5,3),
    NULLIF(item ->> 'three_pointers_made', '')::numeric(5,1),
    NULLIF(item ->> 'points', '')::numeric(5,1),
    NULLIF(item ->> 'rebounds', '')::numeric(5,1),
    NULLIF(item ->> 'assists', '')::numeric(5,1),
    NULLIF(item ->> 'steals', '')::numeric(5,1),
    NULLIF(item ->> 'blocks', '')::numeric(5,1),
    NULLIF(item ->> 'turnovers', '')::numeric(5,1),
    NULLIF(item ->> 'comment', ''),
    p_fetched_at
  FROM jsonb_array_elements(p_rows) AS rows(item);

  SELECT count(*) INTO v_stage_count FROM dynasty_rankings_stage;
  IF v_stage_count <> v_payload_count THEN
    RAISE EXCEPTION 'Staged ranking row count % does not match payload count %', v_stage_count, v_payload_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM dynasty_rankings_stage
    WHERE source_rank IS NULL OR source_rank <= 0 OR source_player_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains invalid rank or player name';
  END IF;

  IF EXISTS (
    SELECT source_rank
    FROM dynasty_rankings_stage
    GROUP BY source_rank
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains duplicate source ranks';
  END IF;

  INSERT INTO public.dynasty_rankings (
    source,
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
  FROM dynasty_rankings_stage
  ON CONFLICT (source, source_rank) DO UPDATE SET
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

  DELETE FROM public.dynasty_rankings AS ranking
  WHERE ranking.source = v_source
    AND NOT EXISTS (
      SELECT 1
      FROM dynasty_rankings_stage AS stage
      WHERE stage.source_rank = ranking.source_rank
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  WITH best_rank AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      source_rank
    FROM dynasty_rankings_stage
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

  UPDATE public.players AS player
     SET dynasty_rank = NULL,
         dynasty_rank_source = NULL,
         dynasty_rank_fetched_at = NULL
   WHERE player.dynasty_rank_source = v_source
     AND NOT EXISTS (
       SELECT 1
       FROM dynasty_rankings_stage AS stage
       WHERE stage.player_id = player.id
     );
  GET DIAGNOSTICS v_players_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'rows', v_stage_count,
    'upserted', v_upserted,
    'deleted', v_deleted,
    'playersUpdated', v_players_updated,
    'playersCleared', v_players_cleared
  );
END;
$$;

REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int) FROM anon;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int) TO service_role;
