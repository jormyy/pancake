CREATE OR REPLACE FUNCTION private.regular_season_matchup_payload(p_league_id uuid, p_season_id uuid, p_weeks int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_members uuid[];
  v_count int;
  v_round int;
  v_week int;
  v_pair int;
  v_home uuid;
  v_away uuid;
  v_played int := 0;
  v_rows jsonb := '[]'::jsonb;
  v_order int[];
  v_a int; v_b int; v_code int; v_index int; v_current int; v_next int; v_edge int;
  v_counts int[]; v_seen int[]; v_degrees int[]; v_forward boolean[];
  v_left int[] := '{}'; v_right int[] := '{}'; v_codes int[] := '{}'; v_used boolean[];
  v_raw jsonb := '[]'; v_row jsonb;
  v_modern boolean; v_previous uuid; v_previous_rows jsonb;
BEGIN
  SELECT matchup_order_version = 1 INTO v_modern FROM public.league_seasons WHERE id = p_season_id AND league_id = p_league_id;
  IF v_modern THEN
    SELECT array_agg(id ORDER BY md5(p_season_id::text || ':' || id::text), id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
    v_count := COALESCE(cardinality(v_members), 0);
    IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
    IF v_count % 2 = 1 THEN v_members := array_append(v_members, NULL::uuid); v_count := v_count + 1; END IF;
    SELECT array_agg(r ORDER BY md5(p_season_id::text || ':round:' || r::text), r) INTO v_order FROM generate_series(0, v_count - 2) r;
    v_counts := array_fill(0, ARRAY[v_count * v_count]);
    v_seen := v_counts;
    v_forward := array_fill(true, ARRAY[v_count * v_count]);
    v_degrees := array_fill(0, ARRAY[v_count]);
    FOR v_week IN 1..p_weeks LOOP
      IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;
      v_round := v_order[1 + v_played % (v_count - 1)];
      v_played := v_played + 1;
      FOR v_pair IN 0..(v_count / 2 - 1) LOOP
        v_a := CASE WHEN v_pair = 0 THEN 1 ELSE 2 + (v_pair - 1 + v_round) % (v_count - 1) END;
        v_b := 2 + (v_count - 2 - v_pair + v_round) % (v_count - 1);
        IF v_members[v_a] IS NULL OR v_members[v_b] IS NULL THEN CONTINUE; END IF;
        v_code := (LEAST(v_a,v_b)-1)*v_count + GREATEST(v_a,v_b);
        v_counts[v_code] := v_counts[v_code] + 1;
        v_raw := v_raw || jsonb_build_array(jsonb_build_object('week',v_week,'a',LEAST(v_a,v_b),'b',GREATEST(v_a,v_b),'code',v_code));
      END LOOP;
    END LOOP;
    FOR v_a IN 1..v_count LOOP
      FOR v_b IN (v_a+1)..v_count LOOP
        v_code := (v_a-1)*v_count+v_b;
        IF v_counts[v_code] % 2 = 1 THEN
          v_left := array_append(v_left,v_a); v_right := array_append(v_right,v_b); v_codes := array_append(v_codes,v_code);
          v_degrees[v_a] := v_degrees[v_a]+1; v_degrees[v_b] := v_degrees[v_b]+1;
        END IF;
      END LOOP;
    END LOOP;
    FOR v_a IN 1..v_count LOOP
      IF v_degrees[v_a] % 2 = 1 THEN
        v_left := array_append(v_left,v_a); v_right := array_append(v_right,v_count+1); v_codes := array_append(v_codes,0);
      END IF;
    END LOOP;
    v_used := array_fill(false,ARRAY[cardinality(v_left)]);
    FOR v_index IN 1..cardinality(v_left) LOOP
      IF v_used[v_index] THEN CONTINUE; END IF;
      v_current := v_left[v_index];
      LOOP
        v_edge := NULL;
        FOR v_pair IN 1..cardinality(v_left) LOOP
          IF NOT v_used[v_pair] AND (v_left[v_pair]=v_current OR v_right[v_pair]=v_current) THEN v_edge:=v_pair; EXIT; END IF;
        END LOOP;
        EXIT WHEN v_edge IS NULL;
        v_used[v_edge] := true;
        v_next := CASE WHEN v_left[v_edge]=v_current THEN v_right[v_edge] ELSE v_left[v_edge] END;
        IF v_codes[v_edge]>0 THEN v_forward[v_codes[v_edge]] := v_left[v_edge]=v_current; END IF;
        v_current := v_next;
      END LOOP;
    END LOOP;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_raw) LOOP
      v_a := (v_row->>'a')::int; v_b := (v_row->>'b')::int; v_code := (v_row->>'code')::int;
      IF v_forward[v_code] = (v_seen[v_code] % 2 = 0) THEN v_home := v_members[v_a]; v_away := v_members[v_b];
      ELSE v_home := v_members[v_b]; v_away := v_members[v_a]; END IF;
      v_seen[v_code] := v_seen[v_code]+1;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('league_id',p_league_id,'league_season_id',p_season_id,'week_number',(v_row->>'week')::int,'matchup_type','regular_season','home_member_id',v_home,'away_member_id',v_away));
    END LOOP;
    SELECT older.id INTO v_previous FROM public.league_seasons older JOIN public.league_seasons current ON current.id=p_season_id
     WHERE older.league_id=p_league_id AND older.season_year<current.season_year ORDER BY older.season_year DESC LIMIT 1;
    IF v_previous IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('week_number',week_number,'matchup_type','regular_season','home_member_id',home_member_id,'away_member_id',away_member_id) ORDER BY week_number,home_member_id,away_member_id)
        INTO v_previous_rows FROM public.matchups WHERE league_season_id=v_previous AND matchup_type='regular_season' AND NOT is_voided;
      IF v_previous_rows IS NULL THEN
        SELECT jsonb_agg(value-'league_id'-'league_season_id' ORDER BY (value->>'week_number')::int,value->>'home_member_id',value->>'away_member_id') INTO v_previous_rows
          FROM jsonb_array_elements(private.regular_season_matchup_payload(p_league_id,v_previous,p_weeks));
      END IF;
      IF v_previous_rows=(SELECT jsonb_agg(value-'league_id'-'league_season_id' ORDER BY (value->>'week_number')::int,value->>'home_member_id',value->>'away_member_id') FROM jsonb_array_elements(v_rows)) THEN
        SELECT jsonb_agg(value || jsonb_build_object('home_member_id',value->>'away_member_id','away_member_id',value->>'home_member_id')) INTO v_rows FROM jsonb_array_elements(v_rows);
      END IF;
    END IF;
    RETURN v_rows;
  END IF;
  SELECT array_agg(id ORDER BY joined_at, id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
  v_count := COALESCE(cardinality(v_members), 0);
  IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
  IF v_count % 2 = 1 THEN
    v_members := array_append(v_members, NULL::uuid);
    v_count := v_count + 1;
  END IF;
  FOR v_week IN 1..p_weeks LOOP
    IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;
    v_round := v_played % (v_count - 1);
    v_played := v_played + 1;
    FOR v_pair IN 0..(v_count / 2 - 1) LOOP
      v_home := CASE WHEN v_pair = 0 THEN v_members[1] ELSE v_members[2 + (v_pair - 1 + v_round) % (v_count - 1)] END;
      v_away := v_members[2 + (v_count - 2 - v_pair + v_round) % (v_count - 1)];
      IF v_home IS NOT NULL AND v_away IS NOT NULL THEN
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'league_id', p_league_id, 'league_season_id', p_season_id,
          'week_number', v_week, 'matchup_type', 'regular_season',
          'home_member_id', v_home, 'away_member_id', v_away));
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_rows;
END;
$$;


CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  IF EXTRACT(ISODOW FROM v_now)::int = 1 AND v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:sync-rankings', to_char(v_now, 'IYYY-IW')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"POINT_3"}'::jsonb);
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"ROOKIE"}'::jsonb);
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"POINT_5"}'::jsonb);
END;
$$;
