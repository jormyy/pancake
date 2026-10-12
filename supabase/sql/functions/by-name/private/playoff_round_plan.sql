-- Canonical SQL source for private.playoff_round_plan.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.playoff_round_plan(p_member_count int, p_total int, p_rounds int[])
RETURNS int[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_round_count int := CASE WHEN p_member_count >= 10 THEN 3 ELSE 2 END;
BEGIN
  IF p_total IS NULL AND p_rounds IS NULL THEN
    RETURN array_fill(1, ARRAY[v_round_count]);
  END IF;
  IF p_total IS NULL OR p_rounds IS NULL
     OR array_ndims(p_rounds) IS DISTINCT FROM 1
     OR array_lower(p_rounds, 1) IS DISTINCT FROM 1
     OR cardinality(p_rounds) <> v_round_count
     OR EXISTS (SELECT 1 FROM unnest(p_rounds) AS value WHERE value IS NULL OR value < 1)
     OR (SELECT sum(value::bigint) FROM unnest(p_rounds) AS value) IS DISTINCT FROM p_total::bigint THEN
    RAISE EXCEPTION 'Playoffs need % rounds. Enter positive whole weeks for each round, adding up to total playoff weeks.', v_round_count
      USING ERRCODE = '22023';
  END IF;
  RETURN p_rounds;
END;
$$;
