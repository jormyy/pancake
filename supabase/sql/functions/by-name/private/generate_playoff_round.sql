-- Canonical SQL source for private.generate_playoff_round.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.generate_playoff_round(p_league_id uuid,p_season_id uuid,p_round int)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_season league_seasons%ROWTYPE; v_order bigint[]; v_seeds uuid[]; v_slots uuid[]; v_next uuid[];
  v_round int; v_pair int; v_index int; v_home uuid; v_away uuid; v_winner uuid;
  v_start int; v_end int; v_type matchup_type; v_inserted int:=0; v_rows int;
BEGIN
  SELECT * INTO v_season FROM league_seasons WHERE id=p_season_id AND league_id=p_league_id;
  v_seeds:=COALESCE(v_season.playoff_bracket_seed_ids,v_season.playoff_seed_member_ids);
  IF v_seeds IS NULL THEN
    RAISE EXCEPTION 'Original playoff seed order is missing. Existing results are unchanged.';
  END IF;
  IF p_round<1 OR p_round>cardinality(v_season.playoff_round_weeks) THEN
    RAISE EXCEPTION 'Requested playoff round is outside the saved elimination plan.' USING ERRCODE='22023';
  END IF;
  v_order:=private.playoff_seed_order(power(2::numeric,cardinality(v_season.playoff_round_weeks))::bigint);
  v_slots:=array_fill(NULL::uuid,ARRAY[cardinality(v_order)]);
  FOR v_index IN 1..cardinality(v_order) LOOP
    IF v_order[v_index]<=cardinality(v_seeds) THEN
      v_slots[v_index]:=v_seeds[v_order[v_index]::int];
    END IF;
  END LOOP;
  FOR v_round IN 1..p_round-1 LOOP
    v_next:='{}';
    FOR v_pair IN 1..cardinality(v_slots)/2 LOOP
      v_home:=v_slots[v_pair*2-1]; v_away:=v_slots[v_pair*2];
      IF v_home IS NULL OR v_away IS NULL THEN
        v_winner:=COALESCE(v_home,v_away);
      ELSE
        SELECT winner_member_id INTO v_winner FROM matchups WHERE league_season_id=p_season_id
          AND playoff_round=v_round AND playoff_position=v_pair AND is_finalized AND winner_member_id IS NOT NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'Playoff round % is not yet finalized.',v_round; END IF;
      END IF;
      v_next:=array_append(v_next,v_winner);
    END LOOP;
    v_slots:=v_next;
  END LOOP;
  v_start:=v_season.playoff_start_week+COALESCE((SELECT sum(length) FROM unnest(v_season.playoff_round_weeks[1:p_round-1]) length),0);
  v_end:=v_start+v_season.playoff_round_weeks[p_round]-1;
  PERFORM private.assert_playoff_window(v_season.season_year,v_start,v_season.playoff_round_weeks[p_round:cardinality(v_season.playoff_round_weeks)]);
  v_type:=CASE cardinality(v_season.playoff_round_weeks)-p_round WHEN 0 THEN 'playoff_final'::matchup_type
    WHEN 1 THEN 'playoff_semifinal'::matchup_type ELSE 'playoff_quarterfinal'::matchup_type END;
  FOR v_pair IN 1..cardinality(v_slots)/2 LOOP
    IF v_slots[v_pair*2-1] IS NOT NULL AND v_slots[v_pair*2] IS NOT NULL THEN
      INSERT INTO matchups(league_id,league_season_id,week_number,end_week_number,matchup_type,
        home_member_id,away_member_id,playoff_round,playoff_position)
      VALUES(p_league_id,p_season_id,v_start,v_end,v_type,v_slots[v_pair*2-1],v_slots[v_pair*2],p_round,v_pair)
      ON CONFLICT (league_id,league_season_id,week_number,home_member_id,away_member_id) DO NOTHING;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      v_inserted:=v_inserted+v_rows;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('inserted',v_inserted,'skipped',v_inserted=0,'round',p_round);
END;
$$;
