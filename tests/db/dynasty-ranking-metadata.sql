BEGIN;

SELECT public.replace_dynasty_rankings(
  'db-metadata-ranking-test',
  '2099-01-01T00:00:00Z'::timestamptz,
  jsonb_build_array(
    jsonb_build_object(
      'source_rank', 1,
      'source_player_id', 'db-metadata-ranking-test-1',
      'source_player_name', 'Metadata Test Player',
      'source_team', 'E2E',
      'source_positions', jsonb_build_array('PG'),
      'player_id', NULL,
      'age', 22.5,
      'rank_change', 0,
      'games_played', 70,
      'field_goal_pct', 0.500,
      'free_throw_pct', 0.800,
      'three_pointers_made', 2.0,
      'points', 20.0,
      'rebounds', 5.0,
      'assists', 6.0,
      'steals', 1.0,
      'blocks', 0.5,
      'turnovers', 2.0,
      'comment', 'Metadata behavior fixture'
    )
  ),
  1,
  'points',
  'https://example.test/dynasty-points',
  jsonb_build_object(
    'requestedRankingType', 'POINT',
    'selectedRankingType', 'POINT',
    'requestMethod', 'POST'
  )
);

DO $$
DECLARE
  v_row public.dynasty_rankings%ROWTYPE;
BEGIN
  SELECT *
    INTO v_row
    FROM public.dynasty_rankings
   WHERE source = 'db-metadata-ranking-test'
     AND source_rank = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Metadata ranking row was not inserted';
  END IF;

  IF v_row.scoring_format <> 'points' THEN
    RAISE EXCEPTION 'Expected scoring_format=points, got %', v_row.scoring_format;
  END IF;

  IF v_row.source_url <> 'https://example.test/dynasty-points' THEN
    RAISE EXCEPTION 'Expected source_url to persist, got %', v_row.source_url;
  END IF;

  IF v_row.source_metadata->>'requestedRankingType' <> 'POINT'
     OR v_row.source_metadata->>'selectedRankingType' <> 'POINT'
     OR v_row.source_metadata->>'requestMethod' <> 'POST' THEN
    RAISE EXCEPTION 'Expected source_metadata to persist, got %', v_row.source_metadata;
  END IF;
END $$;

DO $$
BEGIN
  PERFORM public.replace_dynasty_rankings(
    'db-metadata-ranking-test-invalid',
    now(),
    jsonb_build_array(jsonb_build_object('source_rank', 1, 'source_player_name', 'Invalid Metadata Player')),
    1,
    'points',
    'https://example.test/dynasty-points',
    jsonb_build_array('not', 'an', 'object')
  );
  RAISE EXCEPTION 'Expected invalid source_metadata to fail';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'Ranking source metadata must be a JSON object' THEN
    RAISE;
  END IF;
END $$;

ROLLBACK;
