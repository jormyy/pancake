CREATE OR REPLACE FUNCTION private.league_playoff_round_plan(p_league_id uuid, p_member_count int)
RETURNS int[] LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_league leagues%ROWTYPE; v_round_count int;
BEGIN
  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF v_league.playoff_entrants IS NULL THEN
    RETURN private.playoff_round_plan(p_member_count, v_league.playoff_total_weeks, v_league.playoff_round_weeks);
  END IF;
  IF v_league.playoff_entrants<2 THEN
    RAISE EXCEPTION 'Playoffs require at least 2 entrants.' USING ERRCODE='22023';
  END IF;
  IF v_league.playoff_entrants > p_member_count THEN
    RAISE EXCEPTION 'Playoff entrants (%) exceed league teams (%).', v_league.playoff_entrants, p_member_count USING ERRCODE = '22023';
  END IF;
  v_round_count := ceil(log(2, v_league.playoff_entrants))::int;
  IF cardinality(v_league.playoff_round_lengths) IS DISTINCT FROM v_round_count
     OR array_ndims(v_league.playoff_round_lengths) IS DISTINCT FROM 1
     OR array_lower(v_league.playoff_round_lengths, 1) IS DISTINCT FROM 1
     OR EXISTS (SELECT 1 FROM unnest(v_league.playoff_round_lengths) length WHERE length IS NULL OR length < 1) THEN
    RAISE EXCEPTION 'Playoffs with % entrants need % rounds. Enter positive whole weeks for each round.', v_league.playoff_entrants, v_round_count USING ERRCODE = '22023';
  END IF;
  RETURN v_league.playoff_round_lengths;
END;
$$;
