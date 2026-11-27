-- Canonical SQL source for public.record_nba_draft_class_import.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.record_nba_draft_class_import(
  p_draft_year int,
  p_source text,
  p_picks jsonb,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count int;
BEGIN
  IF p_draft_year IS NULL OR p_draft_year NOT BETWEEN 1947 AND 2100 THEN
    RAISE EXCEPTION 'Invalid draft year.' USING ERRCODE = '22023';
  END IF;
  IF p_error IS NOT NULL THEN
    INSERT INTO public.nba_draft_class_imports (draft_year, last_attempt_at, last_error)
    VALUES (p_draft_year, v_now, left(p_error, 500))
    ON CONFLICT (draft_year) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error;
    RETURN jsonb_build_object('stored', false, 'draftYear', p_draft_year);
  END IF;
  IF p_picks IS NULL OR jsonb_typeof(p_picks) <> 'array' OR jsonb_array_length(p_picks) = 0 OR jsonb_array_length(p_picks) > 100 THEN
    RAISE EXCEPTION 'An official draft board needs between 1 and 100 picks.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_picks) pick
     WHERE jsonb_typeof(pick->'overallPick') IS DISTINCT FROM 'number'
        OR jsonb_typeof(pick->'round') IS DISTINCT FROM 'number'
        OR jsonb_typeof(pick->'playerName') IS DISTINCT FROM 'string'
        OR (pick ? 'personId' AND jsonb_typeof(pick->'personId') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'Each official pick needs an overall pick, round and player name.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_picks) pick
      WHERE (pick->>'overallPick')::numeric NOT BETWEEN 1 AND 100
         OR (pick->>'overallPick')::numeric <> trunc((pick->>'overallPick')::numeric)
         OR (pick->>'round')::numeric NOT BETWEEN 1 AND 10
         OR (pick->>'round')::numeric <> trunc((pick->>'round')::numeric)) THEN
    RAISE EXCEPTION 'An official draft board must list each overall pick once, numbered 1 to 100.' USING ERRCODE = '22023';
  END IF;
  SELECT count(DISTINCT (pick->>'overallPick')::int) INTO v_count FROM jsonb_array_elements(p_picks) pick;
  IF v_count <> jsonb_array_length(p_picks) THEN
    RAISE EXCEPTION 'An official draft board must list each overall pick once, numbered 1 to 100.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.nba_draft_class_imports (draft_year, source, official_picks, board_stored_at, last_attempt_at, last_error)
  VALUES (
    p_draft_year, p_source,
    (SELECT jsonb_agg(jsonb_build_object(
        'overallPick', (pick->>'overallPick')::int,
        'round', (pick->>'round')::int,
        'playerName', btrim(pick->>'playerName'),
        'personId', NULLIF(pick->>'personId', '')
      ) ORDER BY (pick->>'overallPick')::int) FROM jsonb_array_elements(p_picks) pick),
    v_now, v_now, NULL)
  ON CONFLICT (draft_year) DO UPDATE SET
    source = excluded.source, official_picks = excluded.official_picks,
    board_stored_at = excluded.board_stored_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL;
  RETURN jsonb_build_object('stored', true, 'draftYear', p_draft_year, 'picks', v_count);
END;
$$;
